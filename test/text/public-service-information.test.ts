import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { publicInformationUnavailable } from "../../src/core/public-information.ts";
import { proposalHarness, proposalNow, proposalReady, resultValue } from "../support/agent-appointment-proposals.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-322 public information agent answers fence scope, session, clock, proposal and exact source in memory and PostgreSQL", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (adapter: "memory" | "postgres") => {
      const scope = { tenantId: `public-info-${adapter}`, clinicId: "clinic", locationId: "main" };
      const f = proposalHarness(scope, "embedded", adapter === "postgres" ? { ledger: new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference"),
        policy: new MemoryPolicyStore("execute", () => proposalNow, proposalReady, { cancellation: "execute", rescheduling: "execute", intake: "execute" }) } : undefined);
      let clock = proposalNow, reads = 0, sourceRef = "clinic-public-serviceGuidance";
      try {
        await f.enable(); const proposal = await f.admit("cancel"); resultValue(await f.agent.submit(proposal));
        const text = "Initial visit and Follow-up visit are published clinic services. Contact clinic staff for guidance.";
        f.host.readKnowledge = async () => {
          reads++; assert.ok(!Object.values(resultValue(await f.runtime.read(proposal.turn.callId)).actions).some(action => action.status === "awaitingConfirmation"), "cancel before public host IO");
          return { ok: true, value: [{ scope, sourceRef, version: "public-1", ownerRef: "synthetic-owner", approved: true,
            effectiveFrom: proposalNow, effectiveUntil: "2026-10-03T11:00:00.000Z", approvedText: text }] };
        };
        const reception = new TextReception(f.ledger, f.policy, f.host, undefined, undefined, undefined, undefined, () => clock);
        const agent = new CommandGateway({ actorRef: "public-info-agent", role: "agent", scope }, f.policy, reception);
        const command = { kind: "knowledge.answer.v2" as const, turn: { ...proposal.turn, turnId: "public-info", text: "Which appointment type do I need?" }, sourceRefs: [sourceRef], proposedText: text, now: proposalNow };
        const before = resultValue(await f.runtime.read(proposal.turn.callId));
        const foreign = new CommandGateway({ actorRef: "foreign", role: "agent", scope: { ...scope, locationId: "other" } }, f.policy, reception);
        assert.equal((await foreign.submit(command)).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, sessionId: "foreign" } })).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, quality: "needsClarification" } })).ok, false);
        assert.equal((await agent.submit({ ...command, publicTopic: "priceAndFees" } as never)).ok, false);
        assert.equal(reads, 0); assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), before);
        resultValue(await agent.submit(command));
        assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerMessages.at(-1), text);
        assert.equal(Object.values(resultValue(await f.runtime.read(proposal.turn.callId)).actions)[0]!.status, "canceled");
        resultValue(await agent.submit({ ...command, turn: { ...command.turn, turnId: "forged-text" }, proposedText: "You need surgery. It costs $1." }));
        assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerMessages.at(-1), publicInformationUnavailable("serviceGuidance"));
        sourceRef = "clinic-public-directionsAndParking";
        resultValue(await agent.submit({ ...command, turn: { ...command.turn, turnId: "wrong-source" } }));
        assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerMessages.at(-1), publicInformationUnavailable("serviceGuidance"));
        sourceRef = "clinic-public-serviceGuidance";
        const count = reads, after = resultValue(await f.runtime.read(proposal.turn.callId)); clock = "2026-10-03T11:00:00.000Z";
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: "backdated-public-time" } })).ok, false);
        assert.equal(reads, count); assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), after); assert.equal(f.host.writes.length, 0);
      } finally { if ("dispose" in f.ledger && typeof f.ledger.dispose === "function") f.ledger.dispose(); }
    };
    const settled = await Promise.allSettled([run("memory"), run("postgres")]);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
  });
});
