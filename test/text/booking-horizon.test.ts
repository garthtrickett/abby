import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { bookingHorizonUnavailable } from "../../src/core/booking-horizon.ts";
import { proposalHarness, proposalNow, proposalReady, resultValue } from "../support/agent-appointment-proposals.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-321 scoped horizon commands use a private lease clock and refuse caller limits or malformed host evidence in memory and PostgreSQL", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (adapter: "memory" | "postgres") => {
      const scope = { tenantId: `horizon-${adapter}`, clinicId: "clinic", locationId: "main" };
      const f = proposalHarness(scope, "embedded", adapter === "postgres" ? { ledger: new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference"),
        policy: new MemoryPolicyStore("execute", () => proposalNow, proposalReady, { cancellation: "execute", rescheduling: "execute", intake: "execute" }) } : undefined);
      let reads = 0, clock = proposalNow, mutation: Record<string, unknown> = {};
      try {
        await f.enable(); const proposal = await f.admit("cancel"); resultValue(await f.agent.submit(proposal));
        Object.assign(f.host, { readBookingHorizon: async (query: { callId: string; sessionId: string; expectedConversationRevision: number }) => {
          reads++; const state = resultValue(await f.runtime.read(query.callId));
          assert.equal(state.conversationRevision, query.expectedConversationRevision);
          assert.ok(!Object.values(state.actions).some(action => action.status === "awaitingConfirmation"), "supersede before host IO");
          return { ok: true, value: { scope, callId: query.callId, sessionId: query.sessionId, policyVersion: state.policy.policyVersion,
            operation: "book", observedAt: clock, expiresAt: state.sessionLease!.expiresAt,
            bounds: [{ practitionerName: null, minNoticeMinutes: 60, maxAdvanceDays: 30 }], ...mutation } };
        } });
        const reception = new TextReception(f.ledger, f.policy, f.host, undefined, undefined, undefined, undefined, () => clock);
        const agent = new CommandGateway({ actorRef: "horizon-agent", role: "agent", scope }, f.policy, reception);
        const command = { kind: "booking.horizon.read.v1" as const, turn: { ...proposal.turn, turnId: "horizon-query", text: "How far ahead can I book?" }, now: proposalNow };
        const before = resultValue(await f.runtime.read(proposal.turn.callId));
        for (const extra of [{ maxAdvanceDays: 365 }, { from: "2027-01-01" }, { proposedText: "Your time is reserved." }, { patientId: "other" }])
          assert.equal((await agent.submit({ ...command, ...extra } as never)).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, sessionId: "foreign" } })).ok, false);
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, quality: "needsClarification" } })).ok, false);
        const foreign = new CommandGateway({ actorRef: "foreign", role: "agent", scope: { ...scope, locationId: "other" } }, f.policy, reception);
        assert.equal((await foreign.submit(command)).ok, false); assert.equal(reads, 0);
        assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), before);
        resultValue(await agent.submit(command));
        const after = resultValue(await f.runtime.read(proposal.turn.callId));
        assert.match(after.callerMessages.at(-1)!, /at least 60 minutes ahead and no more than 30 days ahead/);
        assert.equal(Object.values(after.actions)[0]!.status, "canceled"); assert.equal(f.host.writes.length, 0);
        let index = 0;
        for (const bad of [{ callId: "foreign" }, { expiresAt: proposalNow }, { bounds: [{ practitionerName: null, minNoticeMinutes: 0, maxAdvanceDays: 365 }] }, { customText: "It is booked." }]) {
          mutation = bad; resultValue(await agent.submit({ ...command, turn: { ...command.turn, turnId: `invalid-host-${index++}` } }));
          assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerMessages.at(-1), bookingHorizonUnavailable);
        }
        const final = resultValue(await f.runtime.read(proposal.turn.callId)), calls = reads;
        clock = "2026-10-03T11:00:00.000Z";
        assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: "backdated" } })).ok, false);
        assert.equal(reads, calls); assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), final);
      } finally { if ("dispose" in f.ledger && typeof f.ledger.dispose === "function") f.ledger.dispose(); }
    };
    const settled = await Promise.allSettled([run("memory"), run("postgres")]);
    for (const item of settled) if (item.status === "rejected") throw item.reason;
  });
});
