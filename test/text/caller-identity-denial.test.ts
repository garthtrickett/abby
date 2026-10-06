import assert from "node:assert/strict";
import test from "node:test";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { callerIdentityDenialText } from "../../src/core/caller-identity.ts";
import { proposalHarness, proposalNow, proposalReady, resultValue } from "../support/agent-appointment-proposals.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-319 agent denial is scoped, monotonic, idempotent and uses a trusted lease clock in memory and PostgreSQL", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (adapter: "memory" | "postgres") => {
      const scope = { tenantId: `identity-${adapter}`, clinicId: "clinic", locationId: "main" };
      const f = proposalHarness(scope, "embedded", adapter === "postgres" ? {
        ledger: new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference"),
        policy: new MemoryPolicyStore("execute", () => proposalNow, proposalReady,
          { cancellation: "execute", rescheduling: "execute", intake: "execute" }),
      } : undefined);
      try {
        Object.assign(f.host, { revokeCallerPatientAccess: async (query: { callId: string; sessionId: string }) => {
          const state = resultValue(await f.runtime.read(query.callId));
          if (!state.callerIdentityDenied || state.sessionLease?.sessionId !== query.sessionId) return false;
          f.host.expected.delete(query.callId); return true;
        } });
        await f.enable(); const proposal = await f.admit("cancel"); resultValue(await f.agent.submit(proposal));
        let clock = proposalNow;
        const reception = new TextReception(f.ledger, f.policy, f.host, undefined, undefined, undefined, undefined, () => clock);
        const agent = new CommandGateway({ actorRef: "deny-agent", role: "agent", scope }, f.policy, reception);
        const command = { kind: "calls.callerIdentity.deny.v1" as const, turn: { ...proposal.turn, turnId: "deny", text: "That isn't me." },
          reason: "identityDisagreement" as const, now: proposalNow };
        const before = resultValue(await f.runtime.read(proposal.turn.callId));
        for (const extra of [{ patientId: "other" }, { phone: "+6125550111" }, { reset: true }, { proposedText: "I restored access." }])
          assert.equal((await agent.submit({ ...command, ...extra } as never)).ok, false);
        assert.equal((await agent.submit({ ...command, reason: "restore" } as never)).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, quality: "needsClarification" } })).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, sessionId: "foreign" } })).ok, false);
        const foreign = new CommandGateway({ actorRef: "foreign", role: "agent", scope: { ...scope, locationId: "elsewhere" } }, f.policy, reception);
        assert.equal((await foreign.submit(command)).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: proposal.turn.turnId } })).ok, false);
        assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), before);
        const reply = resultValue(await agent.submit(command)); resultValue(await agent.submit(command));
        assert.ok("progress" in reply); assert.deepEqual(reply.progress.actions, []); assert.deepEqual(reply.progress.staffItems, []);
        const after = resultValue(await f.runtime.read(proposal.turn.callId));
        assert.equal(after.callerIdentityDenied, "identityDisagreement"); assert.equal(after.callerMessages.length, before.callerMessages.length + 1);
        assert.equal(Object.values(after.actions)[0]!.status, "canceled");
        const reads = f.host.evidenceReads;
        resultValue(await agent.submit({ ...proposal, turn: { ...proposal.turn, turnId: "patient-after-denial" } }));
        resultValue(await agent.submit({ ...command, reason: "sharedPhone", turn: { ...command.turn, turnId: "second-denial" } }));
        const stillDenied = resultValue(await f.runtime.read(proposal.turn.callId));
        assert.equal(f.host.evidenceReads, reads); assert.equal(stillDenied.callerIdentityDenied, "identityDisagreement");
        assert.equal(stillDenied.callerMessages.at(-1), callerIdentityDenialText); assert.equal(f.host.writes.length, 0);
        const publicFailure = resultValue(await f.runtime.acceptTurn({ ...proposal.turn, turnId: "public-times-failed", text: "Are there public times?" },
          { kind: "availabilityFailure", reason: "notConfigured" }, proposalNow));
        assert.equal(publicFailure.callerMessages.at(-1), "I can't send a staff request from this call. Please contact the clinic directly.");
        assert.deepEqual(publicFailure.staffItems, stillDenied.staffItems);
        clock = "2026-10-03T11:00:00.000Z";
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: "backdated" } })).ok, false);
        assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), publicFailure);
      } finally { if ("dispose" in f.ledger && typeof f.ledger.dispose === "function") f.ledger.dispose(); }
    };
    const results = await Promise.allSettled([run("memory"), run("postgres")]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
});

test("E2E-319 a write already sent before denial retains its late receipt without announcing an outcome to the denied caller", { timeout: 30_000 }, async () => {
  const f = proposalHarness({ tenantId: "identity-late-receipt", clinicId: "clinic", locationId: "main" }, "embedded");
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => undefined;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let draining: ReturnType<TextReception["drain"]> | undefined;
  try {
    Object.assign(f.host, { revokeCallerPatientAccess: async () => { f.host.expected.clear(); return true; } });
    await f.enable(); const proposal = await f.admit("cancel"); resultValue(await f.agent.submit(proposal));
    const state = resultValue(await f.runtime.read(proposal.turn.callId)), action = Object.values(state.actions)[0]!;
    resultValue(await f.runtime.startPresentation(proposal.turn.callId, action.presentationId, proposal.turn.sessionId, proposalNow));
    resultValue(await f.runtime.resolvePresentation(proposal.turn.callId, action.presentationId, "played", proposal.turn.sessionId, proposalNow));
    resultValue(await f.reception.affirm(f.scope, { ...proposal.turn, turnId: "confirm", text: "Yes" }, action.key, action.digest, proposalNow));
    const write = f.host.write.bind(f.host);
    f.host.write = async mutation => { started(); await held; return write(mutation); };
    draining = f.reception.drain(f.scope, proposal.turn.callId, proposalNow); await entered;
    const reception = new TextReception(f.ledger, f.policy, f.host, undefined, undefined, undefined, undefined, () => proposalNow);
    resultValue(await reception.denyCallerIdentity(f.scope, { ...proposal.turn, turnId: "deny", text: "That isn't me." }, "identityDisagreement"));
    release(); resultValue(await draining);
    const after = resultValue(await f.runtime.read(proposal.turn.callId));
    assert.equal(after.actions[action.key]!.status, "committed"); assert.equal(f.host.writes.length, 1);
    assert.equal(after.callerMessages.at(-1), callerIdentityDenialText);
    assert.ok(!Object.keys(after.presentations).some(key => key.endsWith(":resultNotice")));
    assert.ok(!Object.values(after.effects).some(effect => effect.kind === "notification"));
  } finally { release(); await draining; if ("dispose" in f.ledger && typeof f.ledger.dispose === "function") f.ledger.dispose(); }
});
