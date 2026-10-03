import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayCommand } from "../../src/reference/command-gateway.ts";
import { proposalCanaries, proposalHarness, proposalNow, resultValue } from "../support/agent-appointment-proposals.ts";
import type { ProposalOperation } from "../support/agent-appointment-proposals.ts";

const operations: readonly ProposalOperation[] = ["cancel", "reschedule", "intake"];

for (const operation of operations) {
  test(`E2E-261 agent ${operation} obeys default off and captures enabled policy before a later disable`, async () => {
    const app = proposalHarness({ tenantId: `toggle-agent-${operation}`, clinicId: "clinic", locationId: "main" }, "embedded");
    resultValue(await app.admin.submit({ kind: "settings.automation.enabled.change.v1", expectedVersion: "0", enabled: true }));
    const initial = await app.admit(operation, "default");
    const defaultReply = resultValue(await app.agent.submit(initial));
    assert.ok("progress" in defaultReply); assert.deepEqual(defaultReply.progress.actions, []);
    const kind = operation === "cancel" ? "settings.appointments.cancellation.enabled.change.v1" as const
      : operation === "reschedule" ? "settings.appointments.rescheduling.enabled.change.v1" as const
      : "settings.patients.firstTimeIntake.enabled.change.v1" as const;
    assert.deepEqual(await app.agent.submit({ kind, expectedVersion: "0", enabled: true }),
      { ok: false, error: { kind: "forbidden" } });
    resultValue(await app.admin.submit({ kind, expectedVersion: "0", enabled: true }));
    const admitted = await app.admit(operation, "enabled");
    resultValue(await app.admin.submit({ kind, expectedVersion: "1", enabled: false }));
    const activeReply = resultValue(await app.agent.submit(admitted));
    assert.ok("progress" in activeReply);
    assert.equal(activeReply.progress.actions[0]?.status, "awaitingConfirmation");
    const next = await app.admit(operation, "disabled");
    const nextReply = resultValue(await app.agent.submit(next));
    assert.ok("progress" in nextReply); assert.deepEqual(nextReply.progress.actions, []);
    assert.equal(app.host.writes.length, 0);
  });

  test(`E2E-261 agent ${operation} proposal needs host evidence, played details and separate caller affirmation`, async () => {
    const app = proposalHarness({ tenantId: `agent-${operation}`, clinicId: "clinic", locationId: "main" }, "embedded");
    await app.enable();
    const command = await app.admit(operation);
    const descriptor = app.agent.listPermitted().find(row => row.id === command.kind);
    assert.ok(descriptor);
    assert.equal(descriptor.effect, "proposalOnly");
    assert.equal(descriptor.requiresCallerConfirmation, true);
    const reply = resultValue(await app.agent.submit(command));
    assert.ok("progress" in reply);
    assert.equal(reply.progress.actions.length, 1);
    assert.equal(reply.progress.actions[0]?.kind, operation);
    assert.equal(reply.progress.actions[0]?.status, "awaitingConfirmation");
    for (const canary of proposalCanaries) assert.equal(JSON.stringify(reply).includes(canary), false);
    const action = Object.values(resultValue(await app.runtime.read(command.turn.callId)).actions)[0]!;
    await app.reception.drain(app.scope, command.turn.callId, proposalNow);
    assert.equal(app.host.writes.length, 0);
    const premature = await app.reception.affirm(app.scope, { ...command.turn, turnId: "premature", text: "Yes" },
      action.key, action.digest, proposalNow);
    assert.equal(premature.ok, false);
    assert.equal(app.host.writes.length, 0);
    resultValue(await app.runtime.startPresentation(command.turn.callId, action.presentationId, command.turn.sessionId, proposalNow));
    resultValue(await app.runtime.resolvePresentation(command.turn.callId, action.presentationId, "played", command.turn.sessionId, proposalNow));
    resultValue(await app.reception.drain(app.scope, command.turn.callId, proposalNow));
    assert.equal(app.host.writes.length, 0);
    const confirmed = resultValue(await app.reception.affirm(app.scope, { ...command.turn, turnId: "caller-yes", text: "Yes" },
      action.key, action.digest, proposalNow));
    assert.equal(confirmed.actions[action.key]?.status, "ready");
    assert.equal(app.host.writes.length, 0);
    const committed = resultValue(await app.reception.drain(app.scope, command.turn.callId, proposalNow));
    assert.equal(committed.actions[action.key]?.status, "committed");
    assert.equal(app.host.writes.length, 1);
    resultValue(await app.agent.submit(command));
    resultValue(await app.reception.drain(app.scope, command.turn.callId, proposalNow));
    assert.equal(app.host.writes.length, 1, "replayed agent input must not replay the patient write");
  });

  test(`E2E-261 strict standalone ${operation} stays unavailable after an admin enables its raw setting`, async () => {
    const app = proposalHarness({ tenantId: `standalone-${operation}`, clinicId: "clinic", locationId: "main" }, "standalone");
    await app.enable();
    const command = await app.admit(operation);
    const reply = resultValue(await app.agent.submit(command));
    assert.ok("progress" in reply);
    assert.deepEqual(reply.progress.actions, []);
    const state = resultValue(await app.reception.drain(app.scope, command.turn.callId, proposalNow));
    assert.equal(state.policy.capabilities[operation], "unavailable");
    assert.equal(app.host.evidenceReads, 0);
    assert.equal(app.host.writes.length, 0);
    assert.ok(state.callerMessages.some(message => /can't|cannot|contact/i.test(message)));
    for (const canary of proposalCanaries) assert.equal(JSON.stringify(reply).includes(canary), false);
  });
}

test("E2E-261 proposal commands reject forged authority, invalid time and session/scope drift", async () => {
  const app = proposalHarness({ tenantId: "proposal-denials", clinicId: "clinic", locationId: "main" }, "embedded");
  await app.enable();
  for (const operation of operations) {
    const command = await app.admit(operation);
    for (const forged of [
      { ...command, actorRef: "clinic-admin" }, { ...command, patientRef: proposalCanaries[0] },
      { ...command, callerConfirmed: true }, { ...command, now: "invalid-time" },
      { ...command, turn: { ...command.turn, sessionId: undefined } },
    ]) {
      assert.deepEqual(await app.agent.submit(forged as GatewayCommand), { ok: false, error: { kind: "invalid" } });
    }
    const beforeReads = app.host.evidenceReads;
    assert.equal((await app.agent.submit({ ...command, turn: { ...command.turn, sessionId: "foreign-session" } })).ok, false);
    const foreign = app.gateway("agent", { ...app.scope, tenantId: "foreign" });
    assert.deepEqual(await foreign.submit(command), { ok: false, error: { kind: "callUnknown" } });
    assert.equal(app.host.evidenceReads, beforeReads);
    assert.equal(app.host.writes.length, 0);
  }
  assert.deepEqual(await app.agent.submit({ kind: "calls.writes.stop.v1", reason: "agent bypass" }),
    { ok: false, error: { kind: "forbidden" } });
});

test("E2E-261 unavailable trusted evidence produces a truthful fallback without an action or write", async () => {
  const app = proposalHarness({ tenantId: "proposal-evidence-failure", clinicId: "clinic", locationId: "main" }, "embedded");
  await app.enable(); app.host.unavailable = true;
  for (const operation of operations) {
    const command = await app.admit(operation);
    const reply = resultValue(await app.agent.submit(command));
    assert.ok("progress" in reply); assert.deepEqual(reply.progress.actions, []);
    const state = resultValue(await app.reception.drain(app.scope, command.turn.callId, proposalNow));
    assert.ok(state.callerMessages.some(message => /can't|cannot|contact/i.test(message)));
    assert.equal(app.host.writes.length, 0);
    for (const canary of proposalCanaries) assert.equal(JSON.stringify(reply).includes(canary), false);
  }
});
