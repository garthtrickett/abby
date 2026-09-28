import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { LocationScope, Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";

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
  const id = `${kind}-intake-${++sequence}`;
  const main: LocationScope = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: "main" };
  const other: LocationScope = { ...main, locationId: "other" };
  const foreign: LocationScope = { tenantId: `foreign-tenant-${id}`, clinicId: `foreign-clinic-${id}`, locationId: "foreign" };
  const account = `account-${id}`;
  const sharedNumber = "+6125550101";
  const singleNumber = "+6125550102";
  const assignments = [
    { accountRef: account, dialedNumber: sharedNumber, ...main, routeVersion: "route-v1" },
    { accountRef: account, dialedNumber: sharedNumber, ...other, routeVersion: "route-v1" },
    { accountRef: account, dialedNumber: singleNumber, ...main, routeVersion: "route-v1" },
  ];
  let routeHost = new ReferenceNumberRoutingHost(assignments);
  let identityReads = 0;
  let policyReads = 0;
  const ledger: LedgerStore = kind === "postgres" ? new PostgresLedger(db!, suggested => suggested) : new MemoryLedger();
  const policy = kind === "postgres"
    ? new PostgresPolicyStore(db!, referenceDefaultPolicy, "execute", async () => ok(true))
    : new MemoryPolicyStore("execute", () => now, async () => ok(true));
  const router = new ClinicPolicyRouter({ identifyCall(accountRef, dialedNumber) {
    identityReads += 1;
    return routeHost.identifyCall(accountRef, dialedNumber);
  } }, { read(scope) { policyReads += 1; return policy.read(scope); } });
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const event = (ref: string, dialedNumber = sharedNumber) =>
    ({ key: { accountRef: account, providerCallRef: `${id}-${ref}` }, dialedNumber, receivedAt: now });
  const turn = (inbound: ReturnType<typeof event>, turnId = "choice") =>
    ({ callId: callIdFor(inbound.key), sessionId: "session", turnId, text: "The other location", quality: "clear" as const, at: now });
  return { main, other, foreign, ledger, policy, router, intake, event, turn, account, sharedNumber, singleNumber,
    identityReads: () => identityReads, policyReads: () => policyReads,
    replaceHost(host: ReferenceNumberRoutingHost) { routeHost = host; } };
}

for (const kind of kinds) {
  test(`${kind}: shared-number retry reuses durable candidates without reading location policy`, async () => {
    const app = fixture(kind);
    const event = app.event("retry");
    const first = value(await app.intake.begin(event));
    assert.equal(first.kind, "locationChoice");
    assert.equal(first.newReservation, true);
    assert.deepEqual(first.pending.route.candidateLocationIds, ["main", "other"]);
    assert.equal(app.policyReads(), 0);
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
    const reads = app.identityReads();
    app.replaceHost(new ReferenceNumberRoutingHost([]));
    const retry = value(await app.intake.begin(event));
    assert.equal(retry.kind, "locationChoice");
    assert.equal(retry.newReservation, false);
    assert.deepEqual(retry.pending, first.pending);
    assert.equal(app.identityReads(), reads);
    const changedNumber = await app.intake.begin({ ...event, dialedNumber: "+6125550199" });
    assert.ok(!changedNumber.ok);
    assert.equal(changedNumber.error.kind, "callConflict");
  });

  test(`${kind}: chosen shared-number location binds before scoped call work`, async () => {
    const app = fixture(kind);
    const event = app.event("chosen");
    value(await app.intake.begin(event));
    const unowned = await app.intake.choose(event, app.turn(event), app.other.locationId, 1);
    assert.ok(!unowned.ok);
    assert.equal(unowned.error.kind, "leaseLost");
    assert.equal(app.policyReads(), 0);
    value(await app.intake.attachSession(event, "session"));
    const wrongSession = await app.intake.choose(event, { ...app.turn(event), sessionId: "other-session" }, app.other.locationId, 1);
    assert.ok(!wrongSession.ok);
    assert.equal(wrongSession.error.kind, "leaseLost");
    const unclear = await app.intake.choose(event, { ...app.turn(event), quality: "needsClarification" }, app.other.locationId, 1);
    assert.ok(!unclear.ok);
    assert.equal(unclear.error.kind, "invalidTransition");
    assert.equal((await new CallRuntime(app.ledger, app.main).read(callIdFor(event.key))).ok, false);
    assert.equal((await new CallRuntime(app.ledger, app.other).read(callIdFor(event.key))).ok, false);
    const invalid = await app.intake.choose(event, app.turn(event), app.foreign.locationId, 1);
    assert.ok(!invalid.ok);
    assert.equal(invalid.error.kind, "invalidLocationChoice");
    assert.equal(app.policyReads(), 0);
    value(await app.policy.changeAutomationEnabled(app.other, "0", true, "clinic-admin"));
    value(await app.policy.changeBookingEnabled(app.other, "0", true, "clinic-admin"));
    const chosen = value(await app.intake.choose(event, app.turn(event), app.other.locationId, 1));
    assert.equal(chosen.kind, "created");
    assert.deepEqual(chosen.receipt.scope, app.other);
    assert.equal(value(await new CallRuntime(app.ledger, app.other).read(chosen.receipt.callId)).policy.numberRouteVersion, "route-v1");
    assert.equal(value(await app.ledger.findPendingLocation(chosen.receipt.callId))?.choiceEvidence?.turnId, "choice");
    assert.equal((await new CallRuntime(app.ledger, app.main).read(chosen.receipt.callId)).ok, false);
    assert.equal((await new CallRuntime(app.ledger, app.foreign).read(chosen.receipt.callId)).ok, false);
    const runtime = new CallRuntime(app.ledger, app.other);
    value(await runtime.activate(chosen.receipt.callId, "session", now));
    const request = { kind: "book" as const,
      patient: { scope: app.other, patientRef: "patient", verificationRef: "verified", expiresAt: "2026-09-28T11:00:00.000Z" },
      offer: { scope: app.other, offerRef: "offer", serviceRef: "service", startsAt: "2026-09-30T10:00:00.000Z",
        expiresAt: "2026-09-28T11:00:00.000Z" } };
    const planned = value(await runtime.acceptTurn({ callId: chosen.receipt.callId, sessionId: "session", turnId: "book",
      text: "Book that appointment", quality: "clear", at: now }, { kind: "requestAction", request }, now));
    assert.equal(Object.values(planned.actions)[0]?.mutation.scope.locationId, app.other.locationId);
    const wrongScope = await runtime.acceptTurn({ callId: chosen.receipt.callId, sessionId: "session", turnId: "wrong-location",
      text: "Book another appointment", quality: "clear", at: now },
    { kind: "requestAction", request: { ...request, offer: { ...request.offer, scope: app.main } } }, now);
    assert.ok(!wrongScope.ok);
    assert.equal(wrongScope.error.kind, "scopeMismatch");
    const retry = value(await app.intake.begin(event));
    assert.equal(retry.kind, "admitted");
    assert.equal(retry.admission.kind, "duplicate");
    const repeatedChoice = value(await app.intake.choose(event, app.turn(event), app.other.locationId, 1));
    assert.equal(repeatedChoice.kind, "duplicate");
    const changedLease = await app.intake.choose(event, app.turn(event), app.other.locationId, 2);
    assert.ok(!changedLease.ok);
    assert.equal(changedLease.error.kind, "keyMismatch");
    const changedChoice = await app.intake.choose(event, app.turn(event), app.main.locationId, 1);
    assert.ok(!changedChoice.ok);
    assert.equal(changedChoice.error.kind, "keyMismatch");
  });

  test(`${kind}: a changed host route prevents stale shared-number choice`, async () => {
    const app = fixture(kind);
    const event = app.event("stale");
    value(await app.intake.begin(event));
    value(await app.intake.attachSession(event, "session"));
    app.replaceHost(new ReferenceNumberRoutingHost([
      { accountRef: app.account, dialedNumber: app.sharedNumber, ...app.main, routeVersion: "route-v2" },
      { accountRef: app.account, dialedNumber: app.sharedNumber, ...app.other, routeVersion: "route-v2" },
    ]));
    const choice = await app.intake.choose(event, app.turn(event), app.main.locationId, 1);
    assert.ok(!choice.ok);
    assert.equal(choice.error.kind, "staleLocationChoice");
    assert.equal(app.policyReads(), 0);
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
  });

  test(`${kind}: selected location still requires enabled automation`, async () => {
    const app = fixture(kind);
    const event = app.event("disabled");
    value(await app.intake.begin(event));
    value(await app.intake.attachSession(event, "session"));
    const disabled = await app.intake.choose(event, app.turn(event), app.other.locationId, 1);
    assert.ok(!disabled.ok);
    assert.equal(disabled.error.kind, "automationDisabled");
    assert.equal(value(await app.ledger.findAdmission(callIdFor(event.key))), null);
    value(await app.policy.changeAutomationEnabled(app.other, "0", true, "clinic-admin"));
    const admitted = value(await app.intake.choose(event, app.turn(event), app.other.locationId, 1));
    assert.equal(admitted.kind, "created");
    assert.deepEqual(admitted.receipt.scope, app.other);
  });

  test(`${kind}: renewed pre-location lease fences the final choice turn`, async () => {
    const app = fixture(kind);
    const event = app.event("renewed-choice");
    value(await app.intake.begin(event));
    const wrongNumber = await app.intake.attachSession({ ...event, dialedNumber: "+6125550199" }, "session");
    assert.ok(!wrongNumber.ok);
    assert.equal(wrongNumber.error.kind, "callConflict");
    const attached = value(await app.intake.attachSession(event, "session"));
    assert.equal(attached.sessionLease?.version, 1);
    const renewed = value(await app.intake.renewSession(event, "session", 1));
    assert.equal(renewed.sessionLease?.version, 2);
    const staleTurn = await app.intake.choose(event, app.turn(event), app.main.locationId, 1);
    assert.ok(!staleTurn.ok);
    assert.equal(staleTurn.error.kind, "leaseLost");
    assert.equal(app.policyReads(), 0);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "clinic-admin"));
    const chosen = value(await app.intake.choose(event, app.turn(event), app.main.locationId, 2));
    assert.equal(chosen.kind, "created");
    assert.deepEqual(chosen.receipt.scope, app.main);
  });

  test(`${kind}: concurrent different choices create only one scoped call`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "clinic-admin"));
    const event = app.event("race");
    value(await app.intake.begin(event));
    value(await app.intake.attachSession(event, "session"));
    const [first, second] = await Promise.all([
      app.intake.choose(event, app.turn(event, "first"), app.main.locationId, 1),
      app.intake.choose(event, app.turn(event, "second"), app.other.locationId, 1),
    ]);
    assert.equal(Number(first.ok) + Number(second.ok), 1);
    const rejected = first.ok ? second : first;
    assert.ok(!rejected.ok);
    assert.ok(rejected.error.kind === "scopeMismatch" || rejected.error.kind === "invalidLocationChoice" || rejected.error.kind === "keyMismatch");
    const receipt = value(await app.ledger.findAdmission(callIdFor(event.key)));
    assert.ok(receipt);
    assert.ok(receipt.scope.locationId === "main" || receipt.scope.locationId === "other");
  });

  test(`${kind}: single-location calls still use normal admission and unknown numbers do not reserve`, async () => {
    const app = fixture(kind);
    value(await app.policy.changeAutomationEnabled(app.main, "0", true, "clinic-admin"));
    const single = app.event("single", app.singleNumber);
    const admitted = value(await app.intake.begin(single));
    assert.equal(admitted.kind, "admitted");
    assert.equal(admitted.admission.kind, "created");
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(single.key))), null);
    const unknown = app.event("unknown", "+6125550199");
    const rejected = await app.intake.begin(unknown);
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.kind, "unknownNumber");
    assert.equal(value(await app.ledger.findPendingLocation(callIdFor(unknown.key))), null);
  });
}
