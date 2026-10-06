import assert from "node:assert/strict";
import test from "node:test";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { proposalHarness, proposalNow, proposalReady, resultValue } from "../support/agent-appointment-proposals.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-320 agent request boundaries cancel unsent proposals with exact scope, input and trusted time in memory and PostgreSQL", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (adapter: "memory" | "postgres") => {
      const scope = { tenantId: `request-boundary-${adapter}`, clinicId: "clinic", locationId: "main" };
      const f = proposalHarness(scope, "embedded", adapter === "postgres" ? {
        ledger: new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference"),
        policy: new MemoryPolicyStore("execute", () => proposalNow, proposalReady, { cancellation: "execute", rescheduling: "execute", intake: "execute" }),
      } : undefined);
      let cleared = 0, clock = proposalNow;
      try {
        Object.assign(f.host, { clearUnsupportedWorkflow: async (query: { callId: string; sessionId: string; turnId: string; conversationRevision: number }) => {
          const state = resultValue(await f.runtime.read(query.callId));
          if (state.lastRequestBoundary?.turnId !== query.turnId || state.sessionLease?.sessionId !== query.sessionId || state.conversationRevision !== query.conversationRevision) return false;
          cleared++; f.host.expected.delete(query.callId); return true;
        } });
        await f.enable(); const proposal = await f.admit("cancel"); resultValue(await f.agent.submit(proposal));
        const reception = new TextReception(f.ledger, f.policy, f.host, undefined, undefined, undefined, undefined, () => clock);
        const agent = new CommandGateway({ actorRef: "boundary-agent", role: "agent", scope }, f.policy, reception);
        const command = { kind: "calls.requestBoundary.respond.v1" as const, turn: { ...proposal.turn, turnId: "proxy-boundary", text: "This request is for my partner." },
          reason: "proxyPatient" as const, now: proposalNow };
        const before = resultValue(await f.runtime.read(proposal.turn.callId));
        for (const extra of [{ patientId: "other" }, { proposedText: "Done." }, { reset: true }, { permission: true }])
          assert.equal((await agent.submit({ ...command, ...extra } as never)).ok, false);
        assert.equal((await agent.submit({ ...command, reason: "grantProxyPermission" } as never)).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, quality: "needsClarification" } })).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, sessionId: "foreign" } })).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: proposal.turn.turnId } })).ok, false);
        const foreign = new CommandGateway({ actorRef: "foreign", role: "agent", scope: { ...scope, locationId: "foreign" } }, f.policy, reception);
        assert.equal((await foreign.submit(command)).ok, false);
        assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), before);
        resultValue(await agent.submit(command)); resultValue(await agent.submit(command));
        const after = resultValue(await f.runtime.read(proposal.turn.callId));
        assert.equal(cleared, 1); assert.equal(after.callerMessages.length, before.callerMessages.length + 1);
        assert.deepEqual(after.lastRequestBoundary, { turnId: "proxy-boundary", reason: "proxyPatient" });
        assert.equal(Object.values(after.actions)[0]!.status, "canceled"); assert.equal(after.callerIdentityDenied, undefined);
        assert.equal((await agent.submit({ ...command, reason: "minorIntake" })).ok, false);
        clock = "2026-10-03T11:00:00.000Z";
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: "backdated" } })).ok, false);
        assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), after); assert.equal(f.host.writes.length, 0);
      } finally { if ("dispose" in f.ledger && typeof f.ledger.dispose === "function") f.ledger.dispose(); }
    };
    const settled = await Promise.allSettled([run("memory"), run("postgres")]);
    for (const item of settled) if (item.status === "rejected") throw item.reason;
  });
});
