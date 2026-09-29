import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { CallRuntime } from "../../src/core/runtime.ts";
import { digestTurn } from "../../src/core/digest.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { up as removeTurnDigests } from "../../src/storage/migrations/015_remove_turn_digests.ts";
import { StaffQueue } from "../../src/reference/staff-queue.ts";
import type { CallsCallId } from "../../src/storage/generated/public/Calls.ts";
import type { EffectOutboxEffectId } from "../../src/storage/generated/public/EffectOutbox.ts";
import type { StaffItemsTaskKey } from "../../src/storage/generated/public/StaffItems.ts";
import { deadline, failure, now, setup, success } from "../text/fixture.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("PostgreSQL caller-turn replay stores neither speech nor a speech-derived digest", async () => {
  const app = await setup("pg-private-turn");
  const text = "synthetic-private-speech-canary";
  const turn = { callId: app.callId, turnId: "private-turn", text, quality: "clear" as const, at: now };
  const interpretation = { kind: "clarify" as const };
  const legacyDigest = digestTurn({ turn, interpretation });
  success(await app.runtime.acceptTurn(turn, interpretation, now));
  const first = success(await app.runtime.read(app.callId));
  success(await app.runtime.acceptTurn({ ...turn, text: "different-replay-canary" }, { kind: "clarify" }, now));
  assert.deepEqual(success(await app.runtime.read(app.callId)), first);
  const row = await db.selectFrom("calls").select("state").where("call_id", "=", app.callId as CallsCallId)
    .executeTakeFirstOrThrow();
  const events = await db.selectFrom("call_events").select("payload").where("call_id", "=", app.callId as CallsCallId).execute();
  const persisted = JSON.stringify({ state: row.state, events });
  assert.equal(persisted.includes(text), false);
  assert.equal(persisted.includes(legacyDigest), false);
  assert.equal(persisted.includes("processedTurnDigests"), false);

  await sql`update calls set state = jsonb_set(state, '{processedTurnDigests}', ${JSON.stringify({ "private-turn": legacyDigest })}::jsonb)
    where call_id = ${app.callId}`.execute(db);
  await removeTurnDigests(db as unknown as Kysely<unknown>);
  const scrubbed = await db.selectFrom("calls").select("state").where("call_id", "=", app.callId as CallsCallId)
    .executeTakeFirstOrThrow();
  assert.equal(JSON.stringify(scrubbed.state).includes(legacyDigest), false);
});

test("global call key and tenant scope are enforced by the database adapter", async () => {
  const app = await setup("pg-uniqueness");
  const otherScope = { tenantId: "another-tenant", clinicId: "another-clinic", locationId: "another-location" };
  const otherPolicy = { ...app.policy, scope: otherScope };
  const other = new CallRuntime(new PostgresLedger(db, undefined, undefined, "unsafeReference"), otherScope);
  failure(await other.start(app.callId, otherPolicy), "invalidTransition");
  failure(await other.read(app.callId), "callUnknown");
  failure(await other.apply(app.callId, 0, { kind: "callerTurn", turn: { callId: app.callId, turnId: "intruder", text: "book", quality: "clear", at: now }, interpretation: { kind: "requestAction", request: app.book() }, now }), "callUnknown");
  assert.equal((await app.state()).version, 0);
});

test("database constraints reject cross-tenant child rows and mismatched JSON scope", async () => {
  const app = await setup("pg-tenant-constraints");
  const wrongTenant = "wrong-tenant";
  const foreignKey = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23503";
  const check = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "23514";
  await assert.rejects(sql`insert into call_events (call_id, tenant_id, sequence, kind, payload)
    values (${app.callId}, ${wrongTenant}, 100, 'forged', '{}'::jsonb)`.execute(db), foreignKey);
  await assert.rejects(sql`insert into effect_outbox (effect_id, call_id, tenant_id, kind, status, payload)
    values (${'forged-effect-pg-tenant-constraints'}, ${app.callId}, ${wrongTenant}, 'staffTask', 'pending', '{}'::jsonb)`.execute(db), foreignKey);
  await assert.rejects(sql`insert into staff_items (task_key, call_id, tenant_id, status, payload)
    values (${'forged-task-pg-tenant-constraints'}, ${app.callId}, ${wrongTenant}, 'requested', '{}'::jsonb)`.execute(db), foreignKey);
  await assert.rejects(sql`update calls set state = jsonb_set(state, '{policy,scope,tenantId}', to_jsonb(${wrongTenant}::text))
    where call_id = ${app.callId}`.execute(db), check);
  const mismatchedPolicy = { ...app.policy, scope: { ...app.scope, tenantId: wrongTenant }, policyVersion: "0" };
  await assert.rejects(sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
    values (${app.scope.tenantId}, ${app.scope.clinicId}, ${app.scope.locationId}, 0, ${JSON.stringify(mismatchedPolicy)}::jsonb)`.execute(db), check);
  assert.equal(success(await app.runtime.read(app.callId)).policy.scope.tenantId, app.scope.tenantId);
});

test("emergency stop latches even when an in-flight outbox row has lost its action key", async () => {
  const app = await setup("pg-stop-corrupt-snapshot");
  await app.turn("request", "Book", { kind: "requestAction", request: app.book() });
  const action = await app.pendingAction();
  await app.confirm(action.key);
  success(await app.runtime.markHostPossiblySent(app.callId, `${action.key}:write`, now));
  await sql`update effect_outbox set payload = payload - 'actionKey'
    where effect_id = ${`${action.key}:write`}`.execute(db);
  const stop = success(await app.ledger.stopWrites(app.scope, "clinic-admin", "Provider incident"));
  assert.equal(stop.stopped, true);
  assert.deepEqual(stop.inFlight.map(item => [item.callId, item.actionKey]), [[app.callId, "unknown"]]);
  assert.equal(success(await new PostgresLedger(db, undefined, undefined, "unsafeReference").readWriteStop(app.scope)).stopped, true);
});

test("PostgreSQL staff queue reads the indexed task projection within one clinic", async () => {
  const app = await setup("pg-staff-queue");
  success(await app.runtime.acceptTurn({ callId: app.callId, turnId: "staff-request", text: "Need staff", quality: "clear", at: now },
    { kind: "handoff", reason: "callerRequested" }, now));
  const queue = new StaffQueue(new PostgresLedger(db, undefined, undefined, "unsafeReference"), () => "2026-09-30T10:00:00.000Z");
  const result = success(await queue.list(app.scope));
  assert.equal(result.items.length, 1);
  assert.deepEqual({ callId: result.items[0]?.callId, reason: result.items[0]?.reason, status: result.items[0]?.status, overdue: result.items[0]?.overdue },
    { callId: app.callId, reason: "callerRequested", status: "requested", overdue: true });
  assert.equal(JSON.stringify(result).includes("Need staff"), false);
  assert.deepEqual(success(await queue.list({ ...app.scope, locationId: "other-location" })).items, []);
});

test("host-confirmed staff resolution commits call, outbox, and queue projection together", async () => {
  const app = await setup("pg-staff-lifecycle-atomic");
  success(await app.runtime.acceptTurn({ callId: app.callId, turnId: "staff-request", text: "Need staff", quality: "clear", at: now },
    { kind: "handoff", reason: "callerRequested" }, now));
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const host = new ReferenceClinicHost([], []);
  const worker = new EffectWorker(app.runtime, host);
  await worker.process(app.callId, `${item.key}:open`, now);
  const requested = success(await app.runtime.requestStaffChange(app.callId, (await app.state()).version, item.key,
    "staff-actor", { kind: "resolve" }));
  const commandKey = requested.staffItems[item.key]?.pendingChangeKey;
  assert.ok(commandKey);
  const pending = await db.selectFrom("staff_items").select(["status", "payload"])
    .where("task_key", "=", item.key as StaffItemsTaskKey).executeTakeFirstOrThrow();
  assert.equal(pending.status, "open");
  assert.equal((pending.payload as { pendingChangeKey?: string }).pendingChangeKey, commandKey);
  await worker.process(app.callId, `${commandKey}:send`, now);
  const state = await app.state();
  const task = await db.selectFrom("staff_items").select(["status", "payload"])
    .where("task_key", "=", item.key as StaffItemsTaskKey).executeTakeFirstOrThrow();
  const effect = await db.selectFrom("effect_outbox").select("status")
    .where("effect_id", "=", `${commandKey}:send` as EffectOutboxEffectId).executeTakeFirstOrThrow();
  const queue = success(await new StaffQueue(new PostgresLedger(db, undefined, undefined, "unsafeReference"), () => "2026-09-30T10:00:00.000Z").list(app.scope));
  assert.equal(state.staffItems[item.key]?.status, "resolved");
  assert.equal(task.status, "resolved");
  assert.equal((task.payload as { pendingChangeKey?: string }).pendingChangeKey, undefined);
  assert.equal(effect.status, "completed");
  assert.equal(queue.items[0]?.status, "resolved");
  assert.equal(queue.items[0]?.overdue, false);
  assert.equal(host.tasks(app.scope)[0]?.status, "resolved");
});

test("calls written before read provenance existed remain readable and upgrade on the next transition", async () => {
  const app = await setup("pg-legacy-knowledge");
  const stored = await db.selectFrom("calls").select("state").where("call_id", "=", app.callId as CallsCallId).executeTakeFirstOrThrow();
  const legacy = { ...(stored.state as Record<string, unknown>) };
  delete legacy.knowledgeAnswers;
  delete legacy.availabilityReads;
  await db.updateTable("calls").set({ state: legacy }).where("call_id", "=", app.callId as CallsCallId).execute();
  const restarted = new CallRuntime(new PostgresLedger(db, undefined, undefined, "unsafeReference"), app.scope);
  assert.deepEqual(success(await restarted.read(app.callId)).knowledgeAnswers, []);
  assert.deepEqual(success(await restarted.read(app.callId)).availabilityReads, []);
  success(await restarted.acceptTurn({ callId: app.callId, turnId: "legacy-next-turn", text: "Please help", quality: "clear", at: now },
    { kind: "handoff", reason: "callerRequested" }, now));
  const upgraded = await db.selectFrom("calls").select("state").where("call_id", "=", app.callId as CallsCallId).executeTakeFirstOrThrow();
  assert.deepEqual((upgraded.state as { knowledgeAnswers?: unknown }).knowledgeAnswers, []);
  assert.deepEqual((upgraded.state as { availabilityReads?: unknown }).availabilityReads, []);
});

test("older ended calls without terminal evidence remain readable while new endings record an audit reason", async () => {
  const app = await setup("pg-terminal-legacy");
  const callId = "pg-terminal-legacy-admitted";
  success(await app.runtime.admit(callId, app.policy, { key: { accountRef: "terminal-account", providerCallRef: "terminal-call" },
    dialedNumber: "+6125550100", acceptedAt: now, deadline: "2026-09-28T10:00:30.000Z" }));
  success(await app.runtime.activate(callId, "terminal-session", "2026-09-28T10:00:01.000Z"));
  const ended = success(await app.runtime.endCall(callId, "terminal-session", "2026-09-28T10:00:02.000Z", "callerDisconnected"));
  assert.equal(ended.terminal?.reason, "callerDisconnected");
  const event = await db.selectFrom("call_events").select(["kind", "payload"]).where("call_id", "=", callId as CallsCallId)
    .orderBy("sequence", "desc").executeTakeFirstOrThrow();
  assert.equal(event.kind, "callEnded");
  assert.equal((event.payload as { reason?: string }).reason, "callerDisconnected");
  const legacy = { ...ended };
  delete legacy.terminal;
  await db.updateTable("calls").set({ state: legacy }).where("call_id", "=", callId as CallsCallId).execute();
  const read = success(await new CallRuntime(new PostgresLedger(db, undefined, undefined, "unsafeReference"), app.scope).read(callId));
  assert.equal(read.lifecycle, "ended");
  assert.equal(read.terminal, undefined);
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
  const restarted = new CallRuntime(new PostgresLedger(db, undefined, undefined, "unsafeReference"), app.scope);
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

test("restart after possible staff-task send keeps operator review and persists exact-key reconciliation", async () => {
  const app = await setup("pg-staff-recovery");
  await app.turn("handoff", "Ask staff to call me", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const effectId = `${item.key}:open`;
  success(await app.runtime.markStaffPossiblySent(app.callId, effectId, now));
  const restarted = new CallRuntime(new PostgresLedger(db, undefined, undefined, "unsafeReference"), app.scope);
  failure(await restarted.recoverStaffPossiblySent(app.callId, effectId, now), "invalidTransition");
  success(await restarted.recoverStaffPossiblySent(app.callId, effectId, "2026-09-28T10:01:01.000Z"));
  const recovered = success(await restarted.read(app.callId));
  assert.equal(recovered.staffItems[item.key]?.status, "needsReview");
  assert.deepEqual(recovered.staffItems[item.key]?.destination, app.policy.operatorQueue);
  assert.equal(recovered.effects[`${effectId}:reconcile`]?.kind, "staffReconcile");
  const reconcileOutbox = await db.selectFrom("effect_outbox").select(["status", "payload"])
    .where("effect_id", "=", `${effectId}:reconcile` as EffectOutboxEffectId).executeTakeFirstOrThrow();
  assert.equal(reconcileOutbox.status, "pending");
  assert.equal((reconcileOutbox.payload as { taskKey: string }).taskKey, item.key);
  const outbox = await db.selectFrom("effect_outbox").select("status")
    .where("effect_id", "=", effectId as EffectOutboxEffectId).executeTakeFirstOrThrow();
  assert.equal(outbox.status, "uncertain");
  assert.equal(app.host.tasks.length, 0);
});
