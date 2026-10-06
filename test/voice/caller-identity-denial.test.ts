import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { callerIdentityDenialText } from "../../src/core/caller-identity.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { cancellationCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { appointmentEnquiryFixture } from "../support/cliniko-appointment-enquiry.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { urgentConversationFixture, urgentQuestion, urgentReply } from "../support/urgent-conversation.ts";
import { clinicFAQFixture, publicDirections } from "../support/clinic-faqs.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

const denied = callerIdentityDenialText;

test("E2E-319 signed caller denial revokes every private workflow, preserves prior receipts and retains approved public information", { timeout: 240_000 }, async () => {
  await withDisposablePostgres(async db => {
    const scenarios = ["initial", "proposal", "committed", "uncertain", "sharedPhone", "sharedPartner", "modelShared", "modelDenial", "forgedModel", "negative", "cancel", "move", "enquiry", "staff", "staffSaved", "urgent"] as const;
    const run = async (scenario: typeof scenarios[number]) => {
    const f = scenario === "cancel" ? await cancellationCallFlowFixture() : scenario === "move" ? await reschedulingCallFlowFixture()
      : scenario === "enquiry" ? await appointmentEnquiryFixture() : scenario.startsWith("staff") ? await clinikoStaffCallFlowFixture()
      : scenario === "urgent" ? await urgentConversationFixture() : await clinicFAQFixture();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    let reads = 0;
    try {
      const port = f.flowConfig.fetchPort!;
      call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => {
        reads++; return port(...args);
      } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
        clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
          const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
          const start = ["I need to book an appointment.", "I need to cancel an appointment.", "I need to move an appointment.", "I only want to check my appointments."].includes(text);
          const operation = text.includes("cancel") ? "cancel" : text.includes("move") ? "reschedule" : text.includes("check") ? "appointments.read" : "book";
          const targets = text === "Show my existing appointments from October 4 through October 9.";
          const appointments = text === "Show me my appointments from October 4 through October 9.";
          const menu = text === "What times are available on October 8?" || text === "Show move times on October 8.";
          const modelDenial = text === "You have linked this conversation to somebody different from its speaker.";
          const modelShared = text === "More than one person uses the line I am calling you on.";
          const faq = text === "Where is the clinic and where can I park?";
          const decision = { kind: start ? "workflow" : targets || menu ? "menu" : appointments ? "appointments" : faq ? "faq" : modelDenial ? "identityDisagreement" : modelShared ? "sharedPhone" : "unsupported",
            operation: start ? operation : null, stage: targets ? "targets" : text === "Show move times on October 8." ? "offers" : null,
            from: targets || appointments ? "2026-10-04" : menu ? "2026-10-08" : null,
            to: targets || appointments ? "2026-10-09" : menu ? "2026-10-08" : null, choice: faq ? 1 : null,
            ...(modelDenial && scenario === "forgedModel" ? { patientId: "different-patient", proposedText: "I changed the patient." } : {}) };
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } }), { lostWrite: scenario === "uncertain" });
      const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
      if (scenario !== "initial") {
        await play(scenario === "cancel" ? "I need to cancel an appointment." : scenario === "move" ? "I need to move an appointment."
          : scenario === "enquiry" ? "I only want to check my appointments." : scenario.startsWith("staff") ? "Could I speak to a receptionist?" : "I need to book an appointment.");
        await voiceUntil(() => f.mail.length === 1, "verification email"); await call.verify(f.mail[0]!.code);
        if (scenario === "cancel") { await play("Show me my appointments from October 4 through October 9."); await play("Cancel that appointment."); }
        else if (scenario === "move") {
          await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment.");
          await play("Show move times on October 8."); await play("The first time, please.");
        } else if (scenario === "enquiry") await play("Show me my appointments from October 4 through October 9.");
        else if (scenario === "staffSaved") await play("Please send that request.");
        else if (!scenario.startsWith("staff") && scenario !== "negative") {
          await play("What times are available on October 8?"); await play("The first time, please.");
        }
        if (scenario === "committed" || scenario === "uncertain") await play("Yes");
      }
      if (scenario === "negative") {
        for (const text of ["This is not a shared phone.", "My neighbour said 'that is not me' yesterday.", "Can you book an appointment for my partner?"]) {
          await play(text); assert.equal((await call.state()).callerIdentityDenied, undefined);
        }
        // The proxy boundary releases unsent patient selections but is not a
        // permanent identity denial. A fresh self request needs new proof.
        await play("I need to book an appointment.");
        await voiceUntil(() => f.mail.length === 2, "fresh self verification after proxy boundary");
        await call.verify(f.mail[1]!.code);
        await play("What times are available on October 8?");
        assert.match(call.spoken.at(-1)!, /Option one/i); return;
      }
      const before = await call.state();
      await play(scenario === "sharedPhone" ? "This is a shared phone." : scenario === "sharedPartner" ? "My partner and I both use the number I am ringing from."
        : scenario === "modelShared" ? "More than one person uses the line I am calling you on." : scenario === "modelDenial" || scenario === "forgedModel"
        ? "You have linked this conversation to somebody different from its speaker." : "That isn't me. This is a shared phone.");
      if (scenario === "forgedModel") { assert.equal((await call.state()).callerIdentityDenied, undefined); return; }
      assert.equal(call.spoken.at(-1), denied, scenario);
      const after = await call.state(); assert.equal(after.callerIdentityDenied, ["sharedPhone", "sharedPartner", "modelShared"].includes(scenario) ? "sharedPhone" : "identityDisagreement");
      for (const action of Object.values(before.actions)) {
        if (action.status === "awaitingConfirmation") assert.equal(after.actions[action.key]?.status, "canceled");
        else assert.deepEqual(after.actions[action.key], action, "denial must not erase or undo a sent action");
      }
      assert.deepEqual(after.staffItems, before.staffItems);
      const writesBefore = call.writes.length;
      const readsBefore = reads, mailBefore = f.mail.length;
      for (const text of ["Yes", "I need to book an appointment.", "What times are available on October 8?", "The first time, please.", "Did you email my confirmation?", "Was my staff request saved?", "Could I speak to a receptionist?"]) {
        await play(text); assert.equal(call.spoken.at(-1), denied);
      }
      assert.equal(reads, readsBefore); assert.equal(f.mail.length, mailBefore); assert.equal(call.writes.length, writesBefore);
      assert.equal((await call.flow.submitCode(f.mail[0]?.code ?? "000000")).verified, false);
      if ("knowledge" in f) { await play("Where is the clinic and where can I park?"); assert.equal(call.spoken.at(-1), publicDirections); }
      if (scenario === "urgent") { await play(urgentQuestion); assert.equal(call.spoken.at(-1), urgentReply); }
      assert.equal(reads, readsBefore); assert.equal(f.mail.length, mailBefore);
      assert.equal(call.flow.closed, false);
    } finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => { for (;;) { const scenario = scenarios[next++]; if (!scenario) return; await run(scenario); } }));
    const failure = workers.find(item => item.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `identity_${index}`, value })))), []);
  });
});
