import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { appointmentEnquiryFixture } from "../support/cliniko-appointment-enquiry.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { proposalHarness, proposalNow, proposalCanaries, resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";

const question = "Could you email me proof of that booking?";
const modelQuestion = "Please tell me what happened to the written message for my visit.";
const unavailable = "I can't verify that an email confirmation was sent or deliver one from this call. Please contact the clinic for written confirmation.";

test("E2E-318 signed email-proof queries distinguish actual action receipts from unproven notification delivery without sending", { timeout: 180_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["committed", "uncertain", "proposal", "none", "enquiry", "cancel", "move", "forgedModel", "wrongChoice", "billingReceipt"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
      const f = scenario === "cancel" ? await cancellationCallFlowFixture() : scenario === "move" ? await reschedulingCallFlowFixture()
        : scenario === "enquiry" ? await appointmentEnquiryFixture() : await bookingCallFlowFixture();
      f.flow.dispose();
      const bodies: string[] = [];
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
            bodies.push(String(init?.body));
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment." || text === "I need to cancel an appointment." || text === "I need to move an appointment." || text === "I only want to check my appointments.";
            const operation = text.includes("cancel") ? "cancel" : text.includes("move") ? "reschedule" : text.includes("check") ? "appointments.read" : "book";
            const targets = text === "Show my existing appointments from October 4 through October 9.";
            const appointments = text === "Show me my appointments from October 4 through October 9.";
            const menu = text === "What times are available on October 8?" || text === "Show move times on October 8.";
            const decision = { kind: start ? "workflow" : targets || menu ? "menu" : appointments ? "appointments" : "notificationOutcome",
              operation: start ? operation : null, stage: targets ? "targets" : text === "Show move times on October 8." ? "offers" : null,
              from: targets || appointments ? "2026-10-04" : menu ? "2026-10-08" : null, to: targets || appointments ? "2026-10-09" : menu ? "2026-10-08" : null,
              choice: scenario === "wrongChoice" && text === modelQuestion ? 1 : null,
              ...(scenario === "forgedModel" && text === modelQuestion ? { proposedText: "The email reached your inbox." } : {}) };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }), { lostWrite: scenario === "uncertain" });
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        if (scenario !== "none" && scenario !== "billingReceipt") {
          await play(scenario === "cancel" ? "I need to cancel an appointment." : scenario === "move" ? "I need to move an appointment."
            : scenario === "enquiry" ? "I only want to check my appointments." : "I need to book an appointment.");
          await voiceUntil(() => f.mail.length === 1, "private verification email"); await call.verify(f.mail[0]!.code);
          if (scenario === "cancel") { await play("Show me my appointments from October 4 through October 9."); await play("Cancel that appointment."); }
          else if (scenario === "move") {
            await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment.");
            await play("Show move times on October 8."); await play("The first time, please.");
          } else if (scenario !== "enquiry") { await play("What times are available on October 8?"); await play("The first time, please."); }
          if (["committed", "uncertain", "cancel", "move", "forgedModel", "wrongChoice"].includes(scenario)) await play("Yes");
        }
        const before = await call.state(), mail = f.mail.length, writes = call.writes.length;
        const invalidOutput = scenario === "forgedModel" || scenario === "wrongChoice";
        const billingQuestion = "Could the clinic send my paid receipt again?";
        await play(scenario === "billingReceipt" ? billingQuestion : invalidOutput ? modelQuestion : question);
        const prefix = scenario === "committed" ? "Your booking is confirmed." : scenario === "cancel" ? "Your appointment cancellation is confirmed."
          : scenario === "move" ? "Your appointment move is confirmed." : scenario === "uncertain" ? "I can't confirm that action yet. It is pending review."
          : scenario === "proposal" ? "That action was not completed." : "I haven't completed an action in this call.";
        const expected = scenario === "billingReceipt" ? "I can't send that staff request from this call. Please contact the clinic directly."
          : invalidOutput ? "I couldn't understand that safely. Could you repeat your request, or contact the clinic directly?" : `${prefix} ${unavailable}`;
        assert.equal(call.spoken.at(-1), expected, scenario);
        const after = await call.state();
        assert.equal(f.mail.length, mail); assert.equal(call.writes.length, writes); assert.deepEqual(after.staffItems, before.staffItems);
        assert.deepEqual(after.effects, before.effects, "read-only status cannot queue a notification, resend, inspection or patient work");
        for (const action of Object.values(before.actions)) {
          if (action.status === "awaitingConfirmation") assert.equal(after.actions[action.key]?.status, "canceled");
          else assert.deepEqual(after.actions[action.key], action);
        }
        await play(scenario === "billingReceipt" ? billingQuestion : modelQuestion); assert.equal(call.spoken.at(-1), expected);
        assert.ok(bodies.every(body => verificationCanaries.every(canary => !body.includes(canary))));
      } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const scenario = scenarios[next++]; if (!scenario) return; await run(scenario); } }));
    const failure = workers.find(item => item.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `notification_${index}`, value })))), []);
  });
});

test("E2E-318 agent notification query reads a real committed action without authorizing delivery or crossing scope", async () => {
  const f = proposalHarness({ tenantId: "notification-agent", clinicId: "clinic", locationId: "main" }, "embedded");
  try {
    await f.enable(); const proposal = await f.admit("cancel");
    resultValue(await f.agent.submit(proposal));
    const state = resultValue(await f.runtime.read(proposal.turn.callId)), action = Object.values(state.actions)[0]!;
    resultValue(await f.runtime.startPresentation(proposal.turn.callId, action.presentationId, proposal.turn.sessionId, proposalNow));
    resultValue(await f.runtime.resolvePresentation(proposal.turn.callId, action.presentationId, "played", proposal.turn.sessionId, proposalNow));
    resultValue(await f.reception.affirm(f.scope, { ...proposal.turn, turnId: "exact-confirmation", text: "Yes" }, action.key, action.digest, proposalNow));
    resultValue(await f.reception.drain(f.scope, proposal.turn.callId, proposalNow));
    let clock = proposalNow;
    const reception = new TextReception(f.ledger, f.policy, f.host, undefined, undefined, undefined, undefined, () => clock);
    const agent = new CommandGateway({ actorRef: "receipt-agent", role: "agent", scope: f.scope }, f.policy, reception);
    const before = resultValue(await f.runtime.read(proposal.turn.callId)), writes = f.host.writes.length;
    const command = { kind: "calls.notifications.outcome.v1" as const, turn: { ...proposal.turn, turnId: "email-proof", text: question }, now: proposalNow };
    const reply = resultValue(await agent.submit(command)); resultValue(await agent.submit(command));
    const after = resultValue(await f.runtime.read(proposal.turn.callId));
    assert.equal(after.callerMessages.at(-1), `Your appointment cancellation is confirmed. ${unavailable}`);
    assert.deepEqual(after.actions, before.actions); assert.deepEqual(after.effects, before.effects); assert.equal(f.host.writes.length, writes);
    assert.equal(after.callerMessages.length, before.callerMessages.length + 1);
    assert.ok(proposalCanaries.every(canary => !JSON.stringify(reply).includes(canary)));
    for (const extra of [{ owner: "abby" }, { outcome: "sent" }, { recipient: "fake@example.test" }, { proposedText: "It reached your inbox." }])
      assert.equal((await agent.submit({ ...command, ...extra } as never)).ok, false);
    const foreign = new CommandGateway({ actorRef: "foreign", role: "agent", scope: { ...f.scope, locationId: "elsewhere" } }, f.policy, reception);
    assert.equal((await foreign.submit(command)).ok, false);
    assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), after);
    clock = "2026-10-03T11:00:00.000Z";
    assert.equal((await agent.submit({ ...command, turn: { ...command.turn, turnId: "expired-session" } })).ok, false);
    assert.deepEqual(resultValue(await f.runtime.read(proposal.turn.callId)), after);
  } finally { if ("dispose" in f.ledger && typeof f.ledger.dispose === "function") f.ledger.dispose(); }
});
