import { approvedSyntheticPolicy } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { Admission, LocationScope, PendingLocationRoute, Result } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { CallLivenessMonitor } from "../../src/voice/call-liveness-monitor.ts";

const now = "2026-09-28T10:00:00.000Z";
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}

let sequence = 0;
function fixture(kind: "memory" | "postgres") {
  const id = `${kind}-pending-${++sequence}`;
  const scope: LocationScope = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: "main" };
  const route: PendingLocationRoute = { tenantId: scope.tenantId, clinicId: scope.clinicId,
    candidateLocationIds: ["main", "other"], candidateNames: [
      { locationId: "main", spokenName: "Main Street" }, { locationId: "other", spokenName: "Northside" },
    ], routeVersion: "route-v1" };
  const key = { accountRef: `account-${id}`, providerCallRef: `call-${id}` };
  const callId = callIdFor(key);
  const admission: Admission = { key, dialedNumber: "+6125550101", acceptedAt: now,
    deadline: new Date(Date.parse(now) + 30_000).toISOString() };
  const ledger: LedgerStore = kind === "postgres" ? new PostgresLedger(db!, suggested => suggested, undefined, "unsafeReference") : new MemoryLedger();
  const policy = { ...approvedSyntheticPolicy(referenceDefaultPolicy(scope)), numberRouteVersion: route.routeVersion };
  return { ledger, route, key, callId, admission, scope, policy };
}

for (const kind of kinds) {
  test(`${kind}: pending location reservation is durable, replay-safe, and prevents a second admission`, async () => {
    const app = fixture(kind);
    const [first, retry] = await Promise.all([
      app.ledger.reservePendingLocation(app.callId, app.route, app.admission),
      app.ledger.reservePendingLocation(app.callId, app.route, app.admission),
    ]);
    assert.deepEqual([value(first).kind, value(retry).kind].sort(), ["created", "duplicate"]);
    const pending = value(await app.ledger.findPendingLocation(app.callId));
    assert.equal(pending?.status, "pending");
    assert.deepEqual(pending?.route.candidateLocationIds, ["main", "other"]);
    assert.equal(value(await app.ledger.findAdmission(app.callId)), null);

    const conflicting = await app.ledger.reservePendingLocation(app.callId, app.route,
      { ...app.admission, dialedNumber: "+6125550199" });
    assert.ok(!conflicting.ok);
    assert.equal(conflicting.error.kind, "callConflict");
    const normalAdmission = await app.ledger.admit(app.callId, app.policy, app.admission);
    assert.ok(!normalAdmission.ok);
    assert.equal(normalAdmission.error.kind, "callConflict");
    const service = new CallAdmissionService(app.ledger, async () => ({ ok: true, value: app.policy }));
    const duplicate = await service.begin({ key: app.key, dialedNumber: app.admission.dialedNumber, receivedAt: now });
    assert.ok(!duplicate.ok);
    assert.equal(duplicate.error.kind, "locationChoicePending");
  });

  test(`${kind}: chosen location binds once and preserves the global call key`, async () => {
    const app = fixture(kind);
    value(await app.ledger.reservePendingLocation(app.callId, app.route, app.admission));
    value(await app.ledger.attachPendingLocationSession(app.callId, "session", now));
    const wrongVersion = await app.ledger.bindPendingLocation(app.callId,
      { ...app.policy, numberRouteVersion: "route-v2" }, "session", 1, "choice", now);
    assert.ok(!wrongVersion.ok);
    assert.equal(wrongVersion.error.kind, "scopeMismatch");
    const wrongLocation = await app.ledger.bindPendingLocation(app.callId,
      { ...app.policy, scope: { ...app.scope, locationId: "foreign" } }, "session", 1, "choice", now);
    assert.ok(!wrongLocation.ok);
    assert.equal(wrongLocation.error.kind, "scopeMismatch");
    assert.equal(value(await app.ledger.findAdmission(app.callId)), null);

    const bound = value(await app.ledger.bindPendingLocation(app.callId, app.policy, "session", 1, "choice", now));
    assert.equal(bound.kind, "created");
    assert.deepEqual(bound.receipt.scope, app.scope);
    assert.equal(value(await app.ledger.findPendingLocation(app.callId))?.status, "bound");
    const repeated = value(await app.ledger.bindPendingLocation(app.callId, app.policy, "session", 1, "choice", now));
    assert.equal(repeated.kind, "duplicate");
    assert.deepEqual(repeated.receipt, bound.receipt);
    const wrongReplay = await app.ledger.bindPendingLocation(app.callId,
      { ...app.policy, scope: { ...app.scope, locationId: "other" } }, "session", 1, "choice", now);
    assert.ok(!wrongReplay.ok);
    assert.equal(wrongReplay.error.kind, "scopeMismatch");
    const service = new CallAdmissionService(app.ledger, async () => { throw new Error("must not reroute"); });
    const replay = value(await service.begin({ key: app.key, dialedNumber: app.admission.dialedNumber, receivedAt: now }));
    assert.equal(replay.kind, "duplicate");
  });

  test(`${kind}: expired choice cannot bind or open a new call under the same key`, async () => {
    const app = fixture(kind);
    value(await app.ledger.reservePendingLocation(app.callId, app.route, app.admission));
    const late = new Date(Date.parse(now) + 120_000).toISOString();
    const outcome = await app.ledger.bindPendingLocation(app.callId, app.policy, "session", 1, "choice", late);
    assert.ok(!outcome.ok);
    assert.equal(outcome.error.kind, "admissionExpired");
    assert.equal(value(await app.ledger.findPendingLocation(app.callId))?.status, "expired");
    assert.equal(value(await app.ledger.findAdmission(app.callId)), null);
    const normalAdmission = await app.ledger.admit(app.callId, app.policy, app.admission);
    assert.ok(!normalAdmission.ok);
    assert.equal(normalAdmission.error.kind, "callConflict");
  });

  test(`${kind}: direct admission and pending reservation cannot both own one call key`, async () => {
    const app = fixture(kind);
    const [admitted, reserved] = await Promise.all([
      app.ledger.admit(app.callId, app.policy, app.admission),
      app.ledger.reservePendingLocation(app.callId, app.route, app.admission),
    ]);
    assert.equal(Number(admitted.ok) + Number(reserved.ok), 1);
    if (!admitted.ok) assert.equal(admitted.error.kind, "callConflict");
    if (!reserved.ok) assert.equal(reserved.error.kind, "callConflict");
    const full = value(await app.ledger.findAdmission(app.callId));
    const pending = value(await app.ledger.findPendingLocation(app.callId));
    assert.equal(Number(full !== null) + Number(pending !== null), 1);
  });

  test(`${kind}: liveness expires an abandoned choice without a caller retry`, async () => {
    const app = fixture(kind);
    value(await app.ledger.reservePendingLocation(app.callId, app.route, app.admission));
    const deadline = new Date(Date.parse(now) + 120_000).toISOString();
    const monitor = new CallLivenessMonitor(app.ledger, app.scope);
    assert.equal(value(await monitor.expireDue(new Date(Date.parse(deadline) - 1).toISOString())), 0);
    assert.equal(value(await monitor.expireDue(deadline)), 1);
    assert.equal(value(await app.ledger.findPendingLocation(app.callId))?.status, "expired");
    assert.equal(value(await monitor.expireDue(deadline)), 0);
    const service = new CallAdmissionService(app.ledger, async () => { throw new Error("must not reroute"); });
    const replay = await service.begin({ key: app.admission.key, dialedNumber: app.admission.dialedNumber, receivedAt: now });
    assert.ok(!replay.ok);
    assert.equal(replay.error.kind, "admissionExpired");
    assert.equal(value(await app.ledger.findAdmission(app.callId)), null);
  });

  test(`${kind}: pending-choice scan is scoped and drains a hundred records per pass`, async () => {
    const app = fixture(kind);
    for (let index = 0; index < 101; index += 1) {
      const key = { ...app.admission.key, providerCallRef: `${app.admission.key.providerCallRef}-${index}` };
      value(await app.ledger.reservePendingLocation(callIdFor(key), app.route, { ...app.admission, key }));
    }
    const foreignKey = { ...app.admission.key, providerCallRef: `${app.admission.key.providerCallRef}-foreign` };
    const foreignRoute = { ...app.route, clinicId: `other-${app.route.clinicId}` };
    value(await app.ledger.reservePendingLocation(callIdFor(foreignKey), foreignRoute, { ...app.admission, key: foreignKey }));
    const late = new Date(Date.parse(now) + 120_000).toISOString();
    const monitor = new CallLivenessMonitor(app.ledger, app.scope);
    assert.equal(value(await monitor.expireDue(late)), 100);
    assert.equal(value(await monitor.expireDue(late)), 1);
    assert.equal(value(await monitor.expireDue(late)), 0);
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(foreignKey)))?.status, "pending");
    assert.equal(value(await new CallLivenessMonitor(app.ledger,
      { tenantId: foreignRoute.tenantId, clinicId: foreignRoute.clinicId, locationId: "foreign" }).expireDue(late)), 1);
  });

  test(`${kind}: expiry and location binding settle to one durable outcome`, async () => {
    const app = fixture(kind);
    value(await app.ledger.reservePendingLocation(app.callId, app.route, app.admission));
    const before = new Date(Date.parse(now) + 119_999).toISOString();
    const deadline = new Date(Date.parse(now) + 120_000).toISOString();
    value(await app.ledger.attachPendingLocationSession(app.callId, "session",
      new Date(Date.parse(now) + 110_000).toISOString()));
    const [bound, expired] = await Promise.all([
      app.ledger.bindPendingLocation(app.callId, app.policy, "session", 1, "choice", before),
      new CallLivenessMonitor(app.ledger, app.scope).expireDue(deadline),
    ]);
    assert.ok(expired.ok);
    const pending = value(await app.ledger.findPendingLocation(app.callId));
    const admitted = value(await app.ledger.findAdmission(app.callId));
    if (bound.ok) {
      assert.equal(bound.value.kind, "created");
      assert.equal(expired.value, 0);
      assert.equal(pending?.status, "bound");
      assert.ok(admitted);
    } else {
      assert.equal(bound.error.kind, "callConflict");
      assert.equal(expired.value, 1);
      assert.equal(pending?.status, "expired");
      assert.equal(admitted, null);
    }
  });

  test(`${kind}: one pre-location session owns a replay-safe renewable lease and choice evidence`, async () => {
    const app = fixture(kind);
    const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
    value(await app.ledger.reservePendingLocation(app.callId, app.route, app.admission));
    const noSession = await app.ledger.bindPendingLocation(app.callId, app.policy, "session", 1, "turn", now);
    assert.ok(!noSession.ok);
    assert.equal(noSession.error.kind, "leaseLost");
    const attached = value(await app.ledger.attachPendingLocationSession(app.callId, "session", now));
    assert.equal(attached.sessionLease?.version, 1);
    assert.equal(attached.sessionLease?.validForMs, 30_000);
    const repeated = value(await app.ledger.attachPendingLocationSession(app.callId, "session", at(5)));
    assert.equal(repeated.sessionLease?.version, 1);
    assert.equal(repeated.sessionLease?.validForMs, 25_000);
    const foreign = await app.ledger.attachPendingLocationSession(app.callId, "other-session", at(5));
    assert.ok(!foreign.ok);
    assert.equal(foreign.error.kind, "leaseLost");

    const renewed = value(await app.ledger.renewPendingLocationSession(app.callId, "session", 1, at(10)));
    assert.equal(renewed.sessionLease?.version, 2);
    assert.equal(renewed.sessionLease?.expiresAt, at(40));
    const replay = value(await app.ledger.renewPendingLocationSession(app.callId, "session", 1, at(15)));
    assert.equal(replay.sessionLease?.version, 2);
    assert.equal(replay.sessionLease?.expiresAt, at(40));
    assert.equal(replay.sessionLease?.validForMs, 25_000);
    const stale = await app.ledger.renewPendingLocationSession(app.callId, "session", 0, at(15));
    assert.ok(!stale.ok);
    assert.equal(stale.error.kind, "leaseLost");
    const wrongOwner = await app.ledger.bindPendingLocation(app.callId, app.policy, "other-session", 2, "turn", at(15));
    assert.ok(!wrongOwner.ok);
    assert.equal(wrongOwner.error.kind, "leaseLost");
    const wrongVersion = await app.ledger.bindPendingLocation(app.callId, app.policy, "session", 1, "turn", at(15));
    assert.ok(!wrongVersion.ok);
    assert.equal(wrongVersion.error.kind, "leaseLost");
    const bound = value(await app.ledger.bindPendingLocation(app.callId, app.policy, "session", 2, "turn", at(15)));
    assert.equal(bound.kind, "created");
    assert.deepEqual(value(await app.ledger.findPendingLocation(app.callId))?.choiceEvidence,
      { sessionId: "session", leaseVersion: 2, turnId: "turn", selectedLocationId: app.scope.locationId, at: at(15) });
  });

  test(`${kind}: E2E-070 a played location prompt repeats only for an explicit silence retry`, async () => {
    const app = fixture(kind);
    value(await app.ledger.reservePendingLocation(app.callId, app.route, app.admission));
    value(await app.ledger.attachPendingLocationSession(app.callId, "session", now));
    const first = value(await app.ledger.startPendingLocationPrompt(app.callId, "first", "session", 1, now));
    assert.equal(first.newStart, true);
    const whileQueued = value(await app.ledger.startPendingLocationPrompt(app.callId, "second", "session", 1, now, true));
    assert.equal(whileQueued.newStart, false);
    value(await app.ledger.resolvePendingLocationPrompt(app.callId, "first", "session", 1, "played", now));
    const ordinaryDispatch = value(await app.ledger.startPendingLocationPrompt(app.callId, "second", "session", 1, now));
    assert.equal(ordinaryDispatch.newStart, false);
    assert.equal(ordinaryDispatch.pending.prompt?.playbackId, "first");
    const silenceRetry = value(await app.ledger.startPendingLocationPrompt(app.callId, "second", "session", 1, now, true));
    assert.equal(silenceRetry.newStart, true);
    assert.equal(silenceRetry.pending.prompt?.playbackId, "second");
    const duplicate = value(await app.ledger.startPendingLocationPrompt(app.callId, "second", "session", 1, now, true));
    assert.equal(duplicate.newStart, false);
  });

  test(`${kind}: expired pre-location lease ends the choice before its two-minute deadline`, async () => {
    const app = fixture(kind);
    value(await app.ledger.reservePendingLocation(app.callId, app.route, app.admission));
    value(await app.ledger.attachPendingLocationSession(app.callId, "session", now));
    const leaseDeadline = new Date(Date.parse(now) + 30_000).toISOString();
    const monitor = new CallLivenessMonitor(app.ledger, app.scope);
    assert.equal(value(await monitor.expireDue(new Date(Date.parse(leaseDeadline) - 1).toISOString())), 0);
    assert.equal(value(await monitor.expireDue(leaseDeadline)), 1);
    assert.equal(value(await app.ledger.findPendingLocation(app.callId))?.status, "expired");
    const renewed = await app.ledger.renewPendingLocationSession(app.callId, "session", 1, leaseDeadline);
    assert.ok(!renewed.ok);
    assert.equal(renewed.error.kind, "leaseLost");
    assert.equal(value(await app.ledger.findAdmission(app.callId)), null);
  });
}
