import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { conversationPresenceText } from "../../src/core/conversation-presence.ts";
import { ok } from "../../src/core/model.ts";
import { proposalHarness, proposalNow, proposalReady, resultValue, proposalCanaries } from "../support/agent-appointment-proposals.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("E2E-324 native presence repair fences scope, session, private clock and proposals without patient work", { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const run = async (adapter: "memory" | "postgres") => {
      const scope = { tenantId: `presence-${adapter}`, clinicId: "clinic", locationId: "main" };
      const f = proposalHarness(scope, "embedded", adapter === "postgres" ? { ledger: new PostgresLedger(db, ref => ref, proposalReady, "unsafeReference"),
        policy: new MemoryPolicyStore("execute", () => proposalNow, proposalReady, { cancellation: "execute", rescheduling: "execute", intake: "execute" }) } : undefined);
      let clock = proposalNow; await f.enable(); const proposal = await f.admit("cancel"); resultValue(await f.agent.submit(proposal));
      const reception = new TextReception(f.ledger, f.policy, f.host, undefined, undefined, undefined, undefined, () => clock);
      const agent = new CommandGateway({ actorRef: "presence-agent", role: "agent", scope }, f.policy, reception);
      const command = { kind: "calls.presence.respond.v1" as const, turn: { ...proposal.turn, turnId: "presence", text: "Are you still there?" }, now: proposalNow };
      const before = resultValue(await f.runtime.read(proposal.turn.callId)), reads = f.host.evidenceReads;
      assert.ok(agent.listPermitted().some(capability => capability.id === command.kind));
      const foreign = new CommandGateway({ actorRef: "foreign", role: "agent", scope: { ...scope, locationId: "other" } }, f.policy, reception);
      assert.equal((await foreign.submit(command)).ok, false);
      for (const bad of [{ ...command, turn: { ...command.turn, sessionId: "other" } }, { ...command, turn: { ...command.turn, quality: "needsClarification" } },
        { ...command, proposedText: "A new time is confirmed." }, { ...command, now: "invalid" }]) assert.equal((await agent.submit(bad as never)).ok, false);
      assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), before);
      const progress = resultValue(await agent.submit(command));
      assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerMessages.at(-1), conversationPresenceText);
      assert.ok(Object.values(resultValue(await f.runtime.read(proposal.turn.callId)).actions).every(action => action.status === "canceled"));
      const repaired = resultValue(await f.runtime.read(proposal.turn.callId)); resultValue(await agent.submit(command));
      assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), repaired);
      assert.ok(!proposalCanaries.some(canary => JSON.stringify(progress).includes(canary)));
      assert.equal(f.host.evidenceReads, reads); assert.equal(f.host.writes.length, 0); assert.equal(f.host.tasks(scope).length, 0);
      resultValue(await f.runtime.acceptTurn({ ...command.turn, turnId: "deny", text: "That's not me." }, { kind: "callerIdentityDenied", reason: "identityDisagreement" }, proposalNow));
      resultValue(await agent.submit({ ...command, turn: { ...command.turn, turnId: "denied-presence" } }));
      assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerIdentityDenied, "identityDisagreement");
      assert.equal(resultValue(await f.runtime.read(proposal.turn.callId)).callerMessages.at(-1), conversationPresenceText);
      const stable = resultValue(await f.runtime.read(proposal.turn.callId)); clock = "2026-10-03T11:00:00.000Z";
      assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: "backdated" } })).ok, false);
      assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), stable);
    };
    const settled = await Promise.allSettled([run("memory"), run("postgres")]);
    for (const result of settled) if (result.status === "rejected") throw result.reason;
  });
});

test("E2E-324 cancellation of a held native menu or direct proposal is stale, with no late state or fallback staff work", { timeout: 90_000 }, async () => {
  const modes = ["bookingMenu", "moveMenu", "bookProposal", "moveProposal"] as const;
  const settled = await Promise.allSettled(modes.map(async mode => {
    const scope = { tenantId: `held-native-${mode}`, clinicId: "clinic", locationId: "main" }, f = proposalHarness(scope, "embedded");
    // This embedded fixture explicitly supplies the host-owned staff-work approval required by menus.
    const readPolicy = f.policy.read.bind(f.policy);
    f.policy.read = async scope => {
      const result = await readPolicy(scope);
      return result.ok ? ok({ ...result.value, staffWorkEnabled: true }) : result;
    };
    await f.enable(); resultValue(await f.admin.submit({ kind: "settings.appointments.booking.enabled.change.v1", expectedVersion: resultValue(await f.policy.read(scope)).policyVersion, enabled: true }));
    const proposal = await f.admit("reschedule");
    const admitted = resultValue(await f.runtime.read(proposal.turn.callId));
    resultValue(await f.runtime.startPresentation(proposal.turn.callId, admitted.pendingPresentationId!, proposal.turn.sessionId, proposalNow));
    resultValue(await f.runtime.resolvePresentation(proposal.turn.callId, admitted.pendingPresentationId!, "played", proposal.turn.sessionId, proposalNow));
    let entered = false, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const unavailable = { ok: false as const, error: { kind: "unavailable" as const, target: "appointment" as const } };
    const host = Object.assign(f.host, {
      bookingMenuAvailable: () => true, reschedulingMenuAvailable: () => true,
      readBookingMenu: async () => { entered = true; await held; return unavailable; }, selectBookingMenu: async () => unavailable,
      readReschedulingMenu: async () => { entered = true; await held; return unavailable; }, selectReschedulingMenu: async () => unavailable,
      resolveBooking: async () => { entered = true; await held; return unavailable; },
      resolveAppointmentChange: async () => { entered = true; await held; return unavailable; },
    });
    const reception = new TextReception(f.ledger, f.policy, host, undefined, undefined, undefined, undefined, () => proposalNow);
    const controller = new AbortController(), turn = { ...proposal.turn, turnId: "held" };
    const pending = mode === "bookingMenu" ? reception.readBookingMenu(scope, turn, "2026-10-08", "2026-10-08", proposalNow, undefined, undefined, controller.signal) :
      mode === "moveMenu" ? reception.readReschedulingMenu(scope, turn, "targets", "2026-10-04", "2026-10-09", proposalNow, false, undefined, controller.signal) :
        mode === "bookProposal" ? reception.proposeBooking(scope, turn, "proof", "offer", proposalNow, undefined, controller.signal) :
          reception.proposeAppointmentChange(scope, turn, { kind: "reschedule", verificationRef: "proof", targetRef: "target", offerRef: "offer" }, proposalNow, undefined, controller.signal);
    try {
      for (let i = 0; i < 100 && !entered; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(entered, true, mode); const before = resultValue(await f.runtime.read(proposal.turn.callId));
      controller.abort(); const result = await pending; assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.kind, "staleTurn", mode);
      release(); assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), before);
      assert.equal(f.host.writes.length, 0); assert.equal(f.host.tasks(scope).length, 0);
    } finally { controller.abort(); release(); await pending; }
  }));
  for (const result of settled) if (result.status === "rejected") throw result.reason;
});
