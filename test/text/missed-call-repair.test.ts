import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { missedCallText } from "../../src/core/missed-call.ts";
import { proposalHarness, proposalNow, proposalReady, resultValue, proposalCanaries } from "../support/agent-appointment-proposals.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-325 native missed-call repair uses private time and scoped public speech without patient or staff work", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (storage: "memory" | "postgres") => {
      const scope = { tenantId: `missed-${storage}`, clinicId: "clinic", locationId: "main" };
      const f = proposalHarness(scope, "embedded", storage === "postgres" ? { ledger: new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference"),
        policy: new MemoryPolicyStore("execute", () => proposalNow, proposalReady, { cancellation: "execute", rescheduling: "execute", intake: "execute" }) } : undefined);
      await f.enable(); const proposal = await f.admit("cancel"); resultValue(await f.agent.submit(proposal));
      let now = proposalNow;
      const reception = new TextReception(f.ledger, f.policy, f.host, undefined, undefined, undefined, undefined, () => now);
      const agent = new CommandGateway({ actorRef: "repair-agent", role: "agent", scope }, f.policy, reception);
      const command = { kind: "calls.missedCall.respond.v1" as const, turn: { ...proposal.turn, turnId: "reason", text: "Why did the clinic call me?" }, now: proposalNow };
      const before = resultValue(await f.runtime.read(proposal.turn.callId)), reads = f.host.evidenceReads;
      assert.ok(agent.listPermitted().some(item => item.id === command.kind));
      const foreign = new CommandGateway({ actorRef: "foreign", role: "agent", scope: { ...scope, locationId: "other" } }, f.policy, reception);
      assert.equal((await foreign.submit(command)).ok, false);
      for (const bad of [{ ...command, turn: { ...command.turn, sessionId: "other" } }, { ...command, turn: { ...command.turn, quality: "needsClarification" } },
        { ...command, proposedText: "The clinic called about your test results." }, { ...command, patientRef: "forged" }, { ...command, now: "invalid" }])
        assert.equal((await agent.submit(bad as never)).ok, false);
      assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), before);
      const progress = resultValue(await agent.submit(command)), repaired = resultValue(await f.runtime.read(proposal.turn.callId));
      assert.equal(repaired.callerMessages.at(-1), missedCallText); assert.ok(Object.values(repaired.actions).every(action => action.status === "canceled"));
      resultValue(await agent.submit(command)); assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), repaired);
      assert.ok(proposalCanaries.every(value => !JSON.stringify(progress).includes(value)));
      assert.equal(f.host.evidenceReads, reads); assert.equal(f.host.writes.length, 0); assert.equal(f.host.tasks(scope).length, 0);
      resultValue(await f.runtime.acceptTurn({ ...command.turn, turnId: "deny", text: "That's not me." }, { kind: "callerIdentityDenied", reason: "identityDisagreement" }, proposalNow));
      resultValue(await agent.submit({ ...command, turn: { ...command.turn, turnId: "denied-reason" } }));
      const stable = resultValue(await f.runtime.read(proposal.turn.callId)); assert.equal(stable.callerIdentityDenied, "identityDisagreement");
      assert.equal(stable.callerMessages.at(-1), missedCallText);
      now = "2026-10-03T11:00:00.000Z";
      assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: "backdated" } })).ok, false);
      assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), stable);
    };
    const settled = await Promise.allSettled([run("memory"), run("postgres")]);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
  });
});
