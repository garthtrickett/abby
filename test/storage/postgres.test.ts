import assert from "node:assert/strict";
import test, { after } from "node:test";
import { CallRuntime } from "../../src/core/runtime.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import type { CallsCallId } from "../../src/storage/generated/public/Calls.ts";
import type { EffectOutboxEffectId } from "../../src/storage/generated/public/EffectOutbox.ts";
import { deadline, failure, now, setup, success } from "../text/fixture.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("global call key and tenant scope are enforced by the database adapter", async () => {
  const app = await setup("pg-uniqueness");
  const otherScope = { tenantId: "another-tenant", clinicId: "another-clinic", locationId: "another-location" };
  const otherPolicy = { ...app.policy, scope: otherScope };
  const other = new CallRuntime(new PostgresLedger(db), otherScope);
  failure(await other.start(app.callId, otherPolicy), "invalidTransition");
  failure(await other.read(app.callId), "callUnknown");
  failure(await other.apply(app.callId, 0, { kind: "callerTurn", turn: { callId: app.callId, turnId: "intruder", text: "book", quality: "clear", at: now }, interpretation: { kind: "requestAction", request: app.book() }, now }), "callUnknown");
  assert.equal((await app.state()).version, 0);
});

test("one transition atomically advances call state, event, and outbox", async () => {
  const app = await setup("pg-atomic");
  await app.turn("request", "Book", { kind: "requestAction", request: app.book() });
  const action = await app.pendingAction();
  await app.confirm(action.key);
  const state = await app.state();
  const call = await db.selectFrom("calls").select(["version", "state"]).where("call_id", "=", app.callId as CallsCallId).executeTakeFirstOrThrow();
  const outbox = await db.selectFrom("effect_outbox").select(["status", "call_id", "tenant_id"])
    .where("effect_id", "=", `${action.key}:write` as EffectOutboxEffectId).executeTakeFirstOrThrow();
  const events = await db.selectFrom("call_events").select("sequence")
    .where("call_id", "=", app.callId as CallsCallId).execute();
  assert.equal(call.version, state.version);
  assert.equal((call.state as { version: number }).version, state.version);
  assert.equal(events.length, state.version);
  assert.equal(outbox.status, "pending");
  assert.equal(outbox.call_id, app.callId);
  assert.equal(outbox.tenant_id, app.scope.tenantId);

  const staleVersion = state.version;
  const turn = { kind: "callerTurn" as const, turn: { callId: app.callId, turnId: "race-a", text: "A", quality: "clear" as const, at: now }, interpretation: { kind: "readFailure" as const, target: "offer" as const, failure: "unavailable" as const }, now };
  const turnB = { ...turn, turn: { ...turn.turn, turnId: "race-b" } };
  const raced = await Promise.all([app.runtime.apply(app.callId, staleVersion, turn), app.runtime.apply(app.callId, staleVersion, turnB)]);
  assert.deepEqual(raced.map(result => result.ok).sort(), [false, true]);
  assert.equal(raced.find(result => !result.ok)?.error.kind, "versionConflict");
  const after = await app.state();
  const afterEvents = await db.selectFrom("call_events").select("sequence").where("call_id", "=", app.callId as CallsCallId).execute();
  assert.equal(after.version, staleVersion + 1);
  assert.equal(afterEvents.length, after.version);
});

test("restart after possible send yields one persisted reconciliation intent", async () => {
  const app = await setup("pg-recovery");
  await app.turn("request", "Book", { kind: "requestAction", request: app.book() });
  const action = await app.pendingAction();
  await app.confirm(action.key);
  success(await app.runtime.markHostPossiblySent(app.callId, `${action.key}:write`, now));
  const restarted = new CallRuntime(new PostgresLedger(db), app.scope);
  const effectId = `${action.key}:write`;
  assert.equal((await restarted.read(app.callId)).ok, true);
  failure(await restarted.recoverHostPossiblySent(app.callId, effectId, now), "invalidTransition");
  const recoveryTime = "2026-09-28T10:01:01.000Z";
  success(await restarted.recoverHostPossiblySent(app.callId, effectId, recoveryTime));
  const recovered = success(await restarted.read(app.callId));
  assert.equal(recovered.actions[action.key]?.status, "uncertain");
  assert.equal(recovered.effects[`${effectId}:reconcile`]?.kind, "hostReconcile");
  assert.equal(recovered.actions[action.key]?.reconciliationDeadline, "2026-09-29T10:01:01.000Z");
  const outbox = await db.selectFrom("effect_outbox").select(["status", "payload"])
    .where("effect_id", "=", `${effectId}:reconcile` as EffectOutboxEffectId).executeTakeFirstOrThrow();
  assert.equal(outbox.status, "pending");
  assert.equal((outbox.payload as { actionKey: string }).actionKey, action.key);
  assert.equal(app.host.writes.length, 0);
  assert.equal(Date.parse(deadline) < Date.parse(recovered.actions[action.key]?.reconciliationDeadline ?? ""), true);
});

test("restart after possible staff-task send keeps the key in operator review", async () => {
  const app = await setup("pg-staff-recovery");
  await app.turn("handoff", "Ask staff to call me", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const effectId = `${item.key}:open`;
  success(await app.runtime.markStaffPossiblySent(app.callId, effectId, now));
  const restarted = new CallRuntime(new PostgresLedger(db), app.scope);
  failure(await restarted.recoverStaffPossiblySent(app.callId, effectId, now), "invalidTransition");
  success(await restarted.recoverStaffPossiblySent(app.callId, effectId, "2026-09-28T10:01:01.000Z"));
  const recovered = success(await restarted.read(app.callId));
  assert.equal(recovered.staffItems[item.key]?.status, "needsReview");
  assert.deepEqual(recovered.staffItems[item.key]?.destination, app.policy.operatorQueue);
  const outbox = await db.selectFrom("effect_outbox").select("status")
    .where("effect_id", "=", effectId as EffectOutboxEffectId).executeTakeFirstOrThrow();
  assert.equal(outbox.status, "uncertain");
  assert.equal(app.host.tasks.length, 0);
});
