import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "kysely";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import type { LedgerStore } from "../../src/core/ledger.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result } from "../../src/core/model.ts";
import { ok } from "../../src/core/model.ts";
import { ModelIngress } from "../../src/model/proposal.ts";
import type { RawModelPort } from "../../src/model/proposal.ts";
import { ModelWork } from "../../src/model/work.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { createEmbeddedTextComposition } from "../../src/reference/embedded-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";

const now = "2026-09-28T10:00:00.000Z";
const kinds = process.env.ABBY_LEDGER === "postgres" ? ["memory", "postgres"] as const : ["memory"] as const;
const db = process.env.DATABASE_URL ? connectPostgres(process.env.DATABASE_URL) : undefined;
after(async () => { await db?.destroy(); });

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

let sequence = 0;
function fixture(kind: "memory" | "postgres", raw: unknown | ((turn: FinalCallerTurn) => unknown), maxTasks = 1_000) {
  const id = `model-${kind}-${++sequence}`;
  const scope: LocationScope = { tenantId: `tenant-${id}`, clinicId: `clinic-${id}`, locationId: `location-${id}` };
  const callId = `call-${id}`;
  const ledger: LedgerStore = kind === "postgres" ? new PostgresLedger(db!, suggestedAt => suggestedAt) : new MemoryLedger();
  const host = new ReferenceClinicHost([], [], [{ scope, sourceRef: "hours", version: "hours-v1", ownerRef: "owner-1",
    approvedText: "We open at 9 am.", approved: true, effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2026-10-01T00:00:00.000Z" }]);
  const policy = new MemoryPolicyStore("execute", () => now, async () => ok(true));
  let calls = 0;
  const port: RawModelPort = { async propose(input) {
    calls += 1;
    return typeof raw === "function" ? raw(input.turn) : raw;
  } };
  const model = new ModelWork(new ModelIngress(port), "prompt-v1", 5_000, maxTasks);
  const reception = createEmbeddedTextComposition(ledger, policy, host, undefined, undefined, model);
  const agent = new CommandGateway({ actorRef: "agent-1", role: "agent", scope }, policy, reception);
  const turn = (turnId: string, text: string, quality: FinalCallerTurn["quality"] = "clear"): FinalCallerTurn =>
    ({ callId, turnId, text, quality, at: now });
  const submit = (turn: FinalCallerTurn) => agent.submit({ kind: "calls.turn.model.v1", turn, now });
  const state = async (): Promise<CallState> => value(await reception.read(scope, callId));
  return { scope, callId, ledger, host, policy, model, reception, agent, turn, submit, state, calls: () => calls };
}

async function start(app: ReturnType<typeof fixture>): Promise<void> {
  value(await app.policy.changeAutomationEnabled(app.scope, "0", true, "test-admin"));
  value(await app.reception.startCall(app.callId, app.scope));
}

for (const kind of kinds) {
  test(`${kind}: default-off automation refuses a model turn without sending caller words`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "handoff", reason: "callerRequested" });
    value(await app.reception.startCall(app.callId, app.scope));
    const unconfigured = new CommandGateway({ actorRef: "agent-unconfigured", role: "agent", scope: app.scope },
      app.policy, createEmbeddedTextComposition(app.ledger, app.policy, app.host));
    assert.equal(unconfigured.listPermitted().some(item => item.id === "calls.turn.model.v1"), false);
    const absent = await unconfigured.submit({ kind: "calls.turn.model.v1", turn: app.turn("turn-absent", "Private caller words"), now });
    assert.equal(absent.ok, false);
    assert.equal(absent.error.kind, "forbidden");
    const result = await app.submit(app.turn("turn-disabled", "Private caller words"));
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, "invalidTransition");
    assert.equal(app.calls(), 0);
    assert.equal(Object.values((await app.state()).effects).length, 0);
    const direct = await new CallRuntime(app.ledger, app.scope).acceptTurn(app.turn("turn-direct", "Private caller words"),
      { kind: "modelPending", taskRef: "a".repeat(64) }, now);
    assert.equal(direct.ok, false);
    assert.equal(direct.error.kind, "invalidTransition");
  });

  test(`${kind}: a different tenant cannot submit a model turn for this call`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "handoff", reason: "callerRequested" });
    await start(app);
    const foreignScope = { ...app.scope, tenantId: "other-tenant" };
    const foreign = new CommandGateway({ actorRef: "foreign-agent", role: "agent", scope: foreignScope },
      app.policy, app.reception);
    const result = await foreign.submit({ kind: "calls.turn.model.v1", turn: app.turn("turn-foreign", "Private caller words"), now });
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, "callUnknown");
    assert.equal(app.calls(), 0);
    assert.equal(Object.values((await app.state()).effects).length, 0);
  });

  test(`${kind}: a voice turn with an older conversation revision cannot queue model work`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "handoff", reason: "callerRequested" });
    await start(app);
    value(await app.submit(app.turn("turn-current", "Current request")));
    const before = await app.state();
    const stale = await app.reception.interpretModelTurn(app.scope, app.turn("turn-stale", "Stale voice request"), now, 0);
    assert.equal(stale.ok, false);
    assert.equal(stale.error.kind, "staleTurn");
    const after = await app.state();
    assert.equal(after.version, before.version);
    assert.equal(after.processedTurnIds.includes("turn-stale"), false);
    assert.equal(JSON.stringify(after).includes("Stale voice request"), false);
    assert.equal(app.calls(), 0);
  });

  test(`${kind}: full transient model queue accepts the turn as staff fallback and replays it once`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "handoff", reason: "callerRequested" }, 1);
    await start(app);
    value(await app.submit(app.turn("turn-first", "First request")));
    const second = app.turn("turn-capacity", "Second request");
    value(await app.submit(second));
    const state = await app.state();
    assert.equal(Object.values(state.staffItems).some(item => item.reason === "systemFailure"), true);
    assert.equal(state.callerMessages.at(-1)?.includes("staff follow-up"), true);
    assert.equal(Object.values(state.effects).filter(item => item.kind === "model" && item.status === "pending").length, 0);
    assert.equal(JSON.stringify(state).includes(second.text), false);
    assert.equal(app.calls(), 0);
    value(await app.submit(second));
    assert.equal((await app.state()).version, state.version);
    assert.equal(Object.values((await app.state()).staffItems).length, 1);
  });

  test(`${kind}: overlong caller text stays out of model memory and receives staff fallback`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "handoff", reason: "callerRequested" });
    await start(app);
    const turn = app.turn("turn-long", "x".repeat(4_001));
    value(await app.submit(turn));
    const state = await app.state();
    assert.equal(Object.values(state.staffItems).some(item => item.reason === "systemFailure"), true);
    assert.equal(Object.values(state.effects).some(item => item.kind === "model"), false);
    assert.equal(JSON.stringify(state).includes(turn.text), false);
    assert.equal(app.calls(), 0);
  });

  test(`${kind}: model answer uses a durable effect, approved source and one caller notice`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"], proposedText: "We open at 9 am." });
    await start(app);
    const turn = app.turn("turn-hours", "What time do you open, Alex?");
    const reply = value(await app.submit(turn));
    assert.equal(reply.kind, "modelTurn");
    assert.equal(app.agent.listPermitted().some(item => item.id === "calls.turn.model.v1"), true);
    let state = await app.state();
    assert.equal(Object.values(state.effects).filter(effect => effect.kind === "model" && effect.status === "pending").length, 1);
    assert.equal(JSON.stringify(state).includes(turn.text), false);
    assert.equal(JSON.stringify(reply).includes(turn.text), false);
    assert.equal(JSON.stringify(state).includes("We open at 9 am."), false);
    value(await app.reception.drain(app.scope, app.callId, now));
    state = await app.state();
    assert.equal(Object.values(state.effects).filter(effect => effect.kind === "modelKnowledge" && effect.status === "pending").length, 1);
    assert.equal(JSON.stringify(state).includes("We open at 9 am."), false);
    value(await app.reception.drain(app.scope, app.callId, now));
    state = await app.state();
    assert.equal(state.knowledgeAnswers.at(-1)?.sourceRef, "hours");
    assert.equal(state.pendingPresentationId && state.presentations[state.pendingPresentationId]?.kind, "notice");
    assert.equal(state.callerMessages.at(-1), "We open at 9 am.");
    assert.equal(app.host.bookings(app.scope).length, 0);
    assert.equal(app.calls(), 1);
    const beforeReplay = state.version;
    value(await app.submit(turn));
    assert.equal((await app.state()).version, beforeReplay);
    assert.equal(app.calls(), 1);
  });

  test(`${kind}: model action proposal requests staff and cannot dispatch a booking`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "action", operation: "book", requestedService: "physio" });
    await start(app);
    value(await app.submit(app.turn("turn-book", "Please book a physio appointment")));
    value(await app.reception.drain(app.scope, app.callId, now));
    const state = await app.state();
    assert.equal(Object.values(state.staffItems).some(item => item.reason === "unsupported"), true);
    assert.match(state.callerMessages.at(-1) ?? "", /can't complete that request automatically/);
    assert.equal(Object.values(state.effects).some(effect => effect.kind === "hostWrite"), false);
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: model answer with invented wording cannot become caller speech`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"], proposedText: "We are open all night." });
    await start(app);
    value(await app.submit(app.turn("turn-invented", "When do you open?")));
    value(await app.reception.drain(app.scope, app.callId, now));
    value(await app.reception.drain(app.scope, app.callId, now));
    const state = await app.state();
    assert.equal(state.knowledgeAnswers.length, 0);
    assert.equal(Object.values(state.staffItems).some(item => item.reason === "systemFailure"), true);
    assert.equal(JSON.stringify(state).includes("We are open all night."), false);
    assert.match(state.callerMessages.at(-1) ?? "", /can't verify that information/);
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: unapproved model source reference is never persisted or spoken`, async () => {
    const privateRef = "Caller Alex private detail";
    const app = fixture(kind, { schemaVersion: 1, kind: "answer", sourceRefs: [privateRef], proposedText: "Unapproved answer" });
    await start(app);
    value(await app.submit(app.turn("turn-private-ref", "Tell me about my record")));
    value(await app.reception.drain(app.scope, app.callId, now));
    assert.equal(JSON.stringify(await app.state()).includes(privateRef), false);
    value(await app.reception.drain(app.scope, app.callId, now));
    const state = await app.state();
    assert.equal(state.knowledgeAnswers.length, 0);
    assert.equal(JSON.stringify(state).includes(privateRef), false);
    assert.equal(JSON.stringify(state).includes("Unapproved answer"), false);
    assert.equal(Object.values(state.staffItems).some(item => item.reason === "systemFailure"), true);
  });

  test(`${kind}: recovery scan processes model and knowledge effects after a lost wake-up`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"], proposedText: "We open at 9 am." });
    await start(app);
    value(await app.submit(app.turn("turn-recover", "What time do you open?")));
    const recovery = new EffectRecovery(app.ledger, () => app.host, app.scope, () => app.model);
    assert.equal(value(await recovery.recover(now)).processed, 1);
    assert.equal(value(await recovery.recover(now)).processed, 1);
    assert.equal((await app.state()).knowledgeAnswers.at(-1)?.sourceRef, "hours");
    assert.equal(app.calls(), 1);
  });

  test(`${kind}: malformed output and lost transient input fail to staff without caller text persistence`, async () => {
    const app = fixture(kind, { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"], proposedText: "Invented answer", hostWrite: true });
    await start(app);
    const turn = app.turn("turn-bad", "Sensitive caller words");
    value(await app.submit(turn));
    value(await app.reception.drain(app.scope, app.callId, now));
    let state = await app.state();
    assert.equal(Object.values(state.staffItems).some(item => item.reason === "systemFailure"), true);
    assert.equal(JSON.stringify(state).includes(turn.text), false);
    assert.equal(JSON.stringify(state).includes("Invented answer"), false);

    const next = app.turn("turn-lost", "Another sensitive request");
    value(await app.submit(next));
    const pending = Object.values((await app.state()).effects).find(effect => effect.kind === "model" && effect.status === "pending");
    assert.ok(pending && pending.kind === "model");
    app.model.forget(pending.taskRef);
    value(await app.reception.drain(app.scope, app.callId, now));
    state = await app.state();
    assert.equal(Object.values(state.staffItems).filter(item => item.reason === "systemFailure").length, 2);
    assert.equal(JSON.stringify(state).includes(next.text), false);
    assert.equal(app.host.bookings(app.scope).length, 0);
  });

  test(`${kind}: correction cancels an older model effect before it can speak`, async () => {
    const app = fixture(kind, () => ({ schemaVersion: 1, kind: "handoff", reason: "callerRequested" }));
    await start(app);
    value(await app.submit(app.turn("turn-old", "First request")));
    const old = Object.values((await app.state()).effects).find(effect => effect.kind === "model");
    assert.ok(old && old.kind === "model");
    value(await app.submit(app.turn("turn-new", "Actually, I need something else")));
    assert.equal((await app.state()).effects[old.id]?.status, "canceled");
    value(await app.reception.drain(app.scope, app.callId, now));
    assert.equal(app.calls(), 1);
    const state = await app.state();
    assert.equal(Object.values(state.staffItems).length, 1);
    assert.equal(Object.values(state.presentations).filter(item => item.status === "pending").length, 1);
  });

  test(`${kind}: correction while the model is running fences its late answer`, async () => {
    let complete: ((raw: unknown) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const app = fixture(kind, () => new Promise<unknown>(resolve => {
      complete = resolve;
      signalStarted?.();
    }));
    await start(app);
    value(await app.submit(app.turn("turn-inflight", "What time do you open?")));
    const effect = Object.values((await app.state()).effects).find(item => item.kind === "model");
    assert.ok(effect);
    const worker = new EffectWorker(new CallRuntime(app.ledger, app.scope), app.host, app.model);
    const work = worker.process(app.callId, effect.id, now);
    await started;
    value(await app.submit(app.turn("turn-correction", "Actually, please ask staff")));
    complete?.({ schemaVersion: 1, kind: "answer", sourceRefs: ["hours"], proposedText: "We open at 9 am." });
    await work;
    const state = await app.state();
    assert.equal(state.effects[effect.id]?.status, "canceled");
    assert.equal(state.knowledgeAnswers.length, 0);
    assert.equal(state.callerMessages.includes("We open at 9 am."), false);
    assert.equal(Object.values(state.presentations).length, 0);
    assert.equal(app.host.bookings(app.scope).length, 0);
  });
}

if (db) {
  test("postgres: malformed persisted model intent is rejected by the recovery scan", async () => {
    const app = fixture("postgres", { schemaVersion: 1, kind: "handoff", reason: "callerRequested" });
    await start(app);
    value(await app.submit(app.turn("turn-corrupt", "Please ask staff")));
    const effect = Object.values((await app.state()).effects).find(item => item.kind === "model");
    assert.ok(effect);
    await sql`update effect_outbox set payload = payload || '{"rawCallerText":"must never persist"}'::jsonb
      where effect_id = ${effect.id}`.execute(db);
    const found = await app.ledger.findRecoverableEffects(now, app.scope);
    assert.equal(found.ok, false);
    assert.equal(found.error.kind, "storageCorrupt");
  });
}
