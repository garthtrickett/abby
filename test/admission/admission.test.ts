import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "kysely";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { CallPolicy, Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import type { CallsCallId } from "../../src/storage/generated/public/Calls.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { CallLivenessMonitor } from "../../src/voice/call-liveness-monitor.ts";

const now = "2026-09-28T10:00:00.000Z";
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

function failure<T>(result: Result<T, { kind: string }>, kind: string): void {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
}

function fixture(kind: "memory" | "postgres", suffix: string) {
  const scope = { tenantId: `admission-tenant-${suffix}`, clinicId: `admission-clinic-${suffix}`, locationId: `admission-location-${suffix}` };
  const policy: CallPolicy = { ...referenceDefaultPolicy(scope), bookingEnabled: true, capabilities: { book: "execute", cancel: "requestOnly", reschedule: "requestOnly", intake: "requestOnly", transfer: "requestOnly" } };
  const ledger: LedgerStore = kind === "postgres" ? new PostgresLedger(db!, suggestedAt => suggestedAt) : new MemoryLedger();
  let routeReads = 0;
  const service = new CallAdmissionService(ledger, async dialed => {
    routeReads += 1;
    return dialed === "+6125550100" ? ok(policy) : { ok: false as const, error: { kind: "routeUnavailable" as const } };
  }, () => now);
  return { scope, policy, ledger, service, routeReads: () => routeReads };
}

for (const kind of kinds) {
  test(`${kind}: concurrent admission creates one call`, async () => {
    const app = fixture(kind, `${kind}-concurrent`);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "concurrent-call" }, dialedNumber: "+6125550100", receivedAt: now };
    const results = await Promise.all([app.service.begin(event), app.service.begin(event)]);
    assert.deepEqual(results.map(result => value(result).kind).sort(), ["created", "duplicate"]);
    assert.equal(value(results[0]!).receipt.callId, value(results[1]!).receipt.callId);
  });

  test(`${kind}: provider replay is global, scoped, and does not re-route`, async () => {
    const app = fixture(kind, `${kind}-replay`);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "provider-call-1" }, dialedNumber: "+6125550100", receivedAt: "2026-09-28T09:59:00.000Z" };
    const created = value(await app.service.begin(event));
    assert.equal(created.kind, "created");
    assert.equal(created.receipt.lifecycle, "starting");
    assert.equal(created.receipt.callId, callIdFor(event.key));
    assert.equal(created.receipt.admission.acceptedAt, now);
    assert.equal(created.receipt.admission.deadline, "2026-09-28T10:00:30.000Z");
    assert.equal(app.routeReads(), 1);
    const replay = value(await app.service.begin({ ...event, receivedAt: "2026-09-28T10:00:03.000Z" }));
    assert.equal(replay.kind, "duplicate");
    assert.equal(app.routeReads(), 1);
    failure(await app.service.begin({ ...event, dialedNumber: "+6125550199" }), "callConflict");
    assert.equal(app.routeReads(), 1);
    failure(await app.ledger.read(created.receipt.callId, { ...app.scope, tenantId: "foreign" }), "callUnknown");
    const second = value(await app.service.begin({ ...event, key: { accountRef: `other-account-${kind}`, providerCallRef: event.key.providerCallRef } }));
    assert.equal(second.kind, "created");
    assert.notEqual(second.receipt.callId, created.receipt.callId);
    assert.equal(app.routeReads(), 2);
    failure(await app.service.begin({ ...event, key: { ...event.key, providerCallRef: "unknown" }, dialedNumber: "+6125550199" }), "routeUnavailable");
    const throwing = new CallAdmissionService(app.ledger, async () => { throw new Error("routing transport failed"); }, () => now);
    failure(await throwing.begin({ ...event, key: { ...event.key, providerCallRef: "throwing" } }), "routeUnavailable");
  });

  test(`${kind}: activation, lease fencing, and disconnect preserve presentation evidence`, async () => {
    const app = fixture(kind, `${kind}-lifecycle`);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "provider-call-2" }, dialedNumber: "+6125550100", receivedAt: now };
    const callId = value(await app.service.begin(event)).receipt.callId;
    const runtime = new CallRuntime(app.ledger, app.scope);
    const earlyTurn = { callId, turnId: "early", text: "Book", quality: "clear" as const, at: now };
    failure(await runtime.acceptTurn(earlyTurn, { kind: "handoff", reason: "callerRequested" }, now), "invalidTransition");
    const active = value(await runtime.activate(callId, "session-1", "2026-09-28T10:00:01.000Z"));
    assert.equal(active.lifecycle, "active");
    assert.equal(active.sessionLease?.version, 1);
    failure(await runtime.activate(callId, "session-2", "2026-09-28T10:00:02.000Z"), "invalidTransition");
    const renewed = value(await runtime.renewSession(callId, "session-1", 1, "2026-09-28T10:00:10.000Z"));
    assert.equal(renewed.sessionLease?.version, 2);
    const replayedRenewal = value(await runtime.renewSession(callId, "session-1", 1, "2026-09-28T10:00:11.000Z"));
    assert.equal(replayedRenewal.version, renewed.version);
    assert.equal(replayedRenewal.sessionLease?.expiresAt, renewed.sessionLease?.expiresAt);
    assert.equal(replayedRenewal.sessionLease?.validForMs, 29_000);
    failure(await runtime.renewSession(callId, "session-1", 0, "2026-09-28T10:00:11.000Z"), "leaseLost");

    const patient = { scope: app.scope, patientRef: "patient", verificationRef: "proof", expiresAt: "2026-09-29T10:00:00.000Z" };
    const offer = { scope: app.scope, offerRef: "offer", serviceRef: "physio", startsAt: "2026-09-29T11:00:00.000Z", expiresAt: "2026-09-29T10:00:00.000Z" };
    const requestAt = "2026-09-28T10:00:11.000Z";
    const request = { callId, sessionId: "session-1", turnId: "request", text: "Book physio", quality: "clear" as const, at: requestAt };
    failure(await runtime.acceptTurn({ ...request, sessionId: "session-2" }, { kind: "requestAction", request: { kind: "book", patient, offer } }, requestAt), "leaseLost");
    const planned = value(await runtime.acceptTurn(request, { kind: "requestAction", request: { kind: "book", patient, offer } }, requestAt));
    const presentationId = Object.keys(planned.presentations)[0];
    assert.ok(presentationId);
    failure(await runtime.startPresentation(callId, presentationId), "leaseLost");
    value(await runtime.startPresentation(callId, presentationId, "session-1", requestAt));
    failure(await runtime.resolvePresentation(callId, presentationId, "played"), "leaseLost");
    const ended = value(await runtime.endCall(callId, "session-1", "2026-09-28T10:00:12.000Z"));
    assert.equal(ended.lifecycle, "ended");
    assert.equal(ended.terminal?.reason, "sessionClosed");
    assert.equal(ended.presentations[presentationId]?.status, "unproven");
    failure(await runtime.acceptTurn({ callId, turnId: "late", text: "Yes", quality: "clear", at: now }, { kind: "handoff", reason: "callerRequested" }, now), "invalidTransition");
    failure(await runtime.resolvePresentation(callId, presentationId, "played"), "invalidTransition");
  });

  test(`${kind}: admission deadline closes starting call without a session`, async () => {
    const app = fixture(kind, `${kind}-expiry`);
    const event = { key: { accountRef: `account-${kind}`, providerCallRef: "provider-call-3" }, dialedNumber: "+6125550100", receivedAt: now };
    const callId = value(await app.service.begin(event)).receipt.callId;
    const runtime = new CallRuntime(app.ledger, app.scope);
    const monitor = new CallLivenessMonitor(app.ledger, app.scope);
    assert.equal(value(await monitor.expireDue("2026-09-28T10:00:29.000Z")), 0);
    assert.equal(value(await monitor.expireDue("2026-09-28T10:00:30.000Z")), 1);
    assert.equal(value(await monitor.expireDue("2026-09-28T10:00:31.000Z")), 0);
    const ended = value(await runtime.read(callId));
    assert.equal(ended.lifecycle, "ended");
    assert.equal(ended.terminal?.reason, "admissionExpired");
    failure(await runtime.activate(callId, "session-too-late", "2026-09-28T10:00:31.000Z"), "invalidTransition");
  });

  test(`${kind}: expired active lease closes call and renewal fences stale expiry`, async () => {
    const app = fixture(kind, `${kind}-lease-expiry`);
    const monitor = new CallLivenessMonitor(app.ledger, app.scope);
    const firstEvent = { key: { accountRef: `account-${kind}`, providerCallRef: "lease-call-1" }, dialedNumber: "+6125550100", receivedAt: now };
    const firstId = value(await app.service.begin(firstEvent)).receipt.callId;
    const first = new CallRuntime(app.ledger, app.scope);
    value(await first.activate(firstId, "lease-session-1", "2026-09-28T10:00:01.000Z"));
    assert.equal(value(await monitor.expireDue("2026-09-28T10:00:30.000Z")), 0);
    failure(await first.acceptTurn({ callId: firstId, sessionId: "lease-session-1", turnId: "expired-turn", text: "Hello", quality: "clear", at: "2026-09-28T10:00:31.000Z" }, { kind: "handoff", reason: "callerRequested" }, "2026-09-28T10:00:31.000Z"), "leaseLost");
    assert.equal(value(await monitor.expireDue("2026-09-28T10:00:31.000Z")), 1);
    assert.equal(value(await first.read(firstId)).lifecycle, "ended");
    assert.equal(value(await first.read(firstId)).terminal?.reason, "leaseExpired");
    failure(await first.renewSession(firstId, "lease-session-1", 1, "2026-09-28T10:00:32.000Z"), "leaseLost");

    const secondId = value(await app.service.begin({ ...firstEvent, key: { ...firstEvent.key, providerCallRef: "lease-call-2" } })).receipt.callId;
    const second = new CallRuntime(app.ledger, app.scope);
    value(await second.activate(secondId, "lease-session-2", "2026-09-28T10:00:01.000Z"));
    value(await second.renewSession(secondId, "lease-session-2", 1, "2026-09-28T10:00:20.000Z"));
    assert.equal(value(await monitor.expireDue("2026-09-28T10:00:31.000Z")), 0);
    assert.equal(value(await second.read(secondId)).lifecycle, "active");
    assert.equal(value(await monitor.expireDue("2026-09-28T10:00:50.000Z")), 1);
  });
}

test("postgres: admission and activation events persist as separate versions", { skip: !db }, async () => {
  const app = fixture("postgres", "postgres-events");
  const event = { key: { accountRef: "account-events", providerCallRef: "call-events" }, dialedNumber: "+6125550100", receivedAt: now };
  const callId = value(await app.service.begin(event)).receipt.callId;
  const runtime = new CallRuntime(app.ledger, app.scope);
  value(await runtime.activate(callId, "session-events", "2026-09-28T10:00:01.000Z"));
  const rows = await db!.selectFrom("call_events").select(["sequence", "kind"]).where("call_id", "=", callId as CallsCallId).orderBy("sequence").execute();
  assert.deepEqual(rows.map(row => [row.sequence, row.kind]), [[0, "callAdmitted"], [1, "sessionActivated"]]);
});

test("postgres: ledger clock rejects forged intake, renewal, and expiry timestamps", { skip: !db }, async () => {
  const scope = { tenantId: "database-clock-tenant", clinicId: "database-clock-clinic", locationId: "database-clock-location" };
  const ledger = new PostgresLedger(db!);
  const basePolicy = referenceDefaultPolicy(scope);
  const policy: CallPolicy = { ...basePolicy, capabilities: { ...basePolicy.capabilities, transfer: "execute" }, transferDestinationRef: "database-clock-destination" };
  const before = await sql<{ current_time: Date }>`select clock_timestamp() as current_time`.execute(db!);
  const service = new CallAdmissionService(ledger, async () => ok(policy), () => "2000-01-01T00:00:00.000Z");
  const admitted = value(await service.begin({
    key: { accountRef: "database-clock-account", providerCallRef: "database-clock-call" },
    dialedNumber: "+6125550100", receivedAt: "2000-01-01T00:00:00.000Z",
  }));
  const after = await sql<{ current_time: Date }>`select clock_timestamp() as current_time`.execute(db!);
  const acceptedAt = Date.parse(admitted.receipt.admission.acceptedAt);
  assert.ok(acceptedAt >= before.rows[0]!.current_time.getTime());
  assert.ok(acceptedAt <= after.rows[0]!.current_time.getTime());
  assert.equal(Date.parse(admitted.receipt.admission.deadline) - acceptedAt, 30_000);
  const runtime = new CallRuntime(ledger, scope);
  const monitor = new CallLivenessMonitor(ledger, scope);
  assert.equal(value(await monitor.expireDue("2099-01-01T00:00:00.000Z")), 0);
  const active = value(await runtime.activate(admitted.receipt.callId, "database-clock-session", "2000-01-01T00:00:00.000Z"));
  assert.equal(active.sessionLease?.validForMs, 30_000);
  const renewed = value(await runtime.renewSession(admitted.receipt.callId, "database-clock-session", 1, "2099-01-01T00:00:00.000Z"));
  assert.equal(renewed.sessionLease?.version, 2);
  const replay = value(await runtime.renewSession(admitted.receipt.callId, "database-clock-session", 1, "2000-01-01T00:00:00.000Z"));
  assert.equal(replay.sessionLease?.expiresAt, renewed.sessionLease?.expiresAt);
  assert.ok(replay.sessionLease!.validForMs > 0 && replay.sessionLease!.validForMs <= 30_000);
  const extensionMs = Date.parse(renewed.sessionLease!.expiresAt) - Date.parse(active.sessionLease!.expiresAt);
  assert.ok(extensionMs >= 0 && extensionMs < 30_000);
  const planned = value(await runtime.acceptTurn({ callId: admitted.receipt.callId, sessionId: "database-clock-session", turnId: "database-clock-turn", text: "Transfer me", quality: "clear", at: "2000-01-01T00:00:00.000Z" }, { kind: "transfer", reason: "callerRequested" }, "2099-01-01T00:00:00.000Z"));
  const presentationId = planned.pendingPresentationId!;
  assert.ok(presentationId);
  value(await runtime.startPresentation(admitted.receipt.callId, presentationId, "database-clock-session", "2000-01-01T00:00:00.000Z"));
  value(await runtime.markTransferPossiblySent(admitted.receipt.callId, presentationId, "database-clock-session", "2099-01-01T00:00:00.000Z"));
  const failed = value(await runtime.resolvePresentation(admitted.receipt.callId, presentationId, "failed", "database-clock-session", "2000-01-01T00:00:00.000Z"));
  assert.equal(failed.presentations[presentationId]?.status, "failed");
  failure(await runtime.expireSession(admitted.receipt.callId, "database-clock-session", 2, "2099-01-01T00:00:00.000Z"), "leaseLost");
  assert.equal(value(await monitor.expireDue("2099-01-01T00:00:00.000Z")), 0);
  assert.equal(value(await runtime.read(admitted.receipt.callId)).lifecycle, "active");
});
