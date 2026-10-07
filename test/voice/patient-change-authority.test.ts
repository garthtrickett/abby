import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { callerIdentityDenialText } from "../../src/core/caller-identity.ts";
import { callerIdentityLanguage } from "../../src/standalone/caller-identity-language.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { appointmentEnquiryFixture } from "../support/cliniko-appointment-enquiry.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const nameCorrection = "My name is IdentityReplacementCanary, not IdentityPreviousCanary.";
const draft = "The message is: IdentityMessageCanary awaiting a referral.";
test("E2E-339 patient changes and shared-number declarations revoke old private authority before model inference, preserving prior receipts", { timeout: 150_000 }, async () => {
 await withDisposablePostgres(async db => {
  const modes = ["role", "name", "other", "proxy", "owner", "borrowed", "notMe", "directProxy", "shared", "surname", "cancel", "move", "enquiry", "staffDraft", "staffSaved", "committed", "unknown"] as const;
  const failures: unknown[] = [];
  const run = async (mode: typeof modes[number]) => {
   const staff = mode.startsWith("staff"), move = mode === "move", cancel = mode === "cancel", enquiry = mode === "enquiry";
   const f = staff ? await clinikoStaffCallFlowFixture() : move ? await reschedulingCallFlowFixture() : cancel ? await cancellationCallFlowFixture() : enquiry ? await appointmentEnquiryFixture() : await bookingCallFlowFixture(); f.flow.dispose();
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = []; let reads = 0;
   try {
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { if ((args[1]?.method ?? "GET") === "GET") reads++; return port(...args); } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
     const workflow = /^I need to (?:book|cancel|move) an appointment\.$/.test(text) || text === "I only want to check my appointments.";
     const targets = text === "Show my existing appointments from October 4 through October 9.", appointments = text === "Show me my appointments from October 4 through October 9.", menu = text === "Show times on October 8.";
     const decision = { kind: workflow ? "workflow" : targets || menu ? "menu" : appointments ? "appointments" : "unsupported", operation: workflow ? move ? "reschedule" : cancel ? "cancel" : enquiry ? "appointments.read" : "book" : null, stage: targets ? "targets" : move && menu ? "offers" : null, from: targets || appointments ? "2026-10-04" : menu ? "2026-10-08" : null, to: targets || appointments ? "2026-10-09" : menu ? "2026-10-08" : null, choice: null };
     return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }), { lostWrite: mode === "unknown" });
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    await play(staff ? mode === "staffDraft" ? "I would like to leave a detailed message." : "Could I speak to a receptionist?" : move ? "I need to move an appointment." : cancel ? "I need to cancel an appointment." : enquiry ? "I only want to check my appointments." : "I need to book an appointment.");
    await voiceUntil(() => f.mail.length === 1, "patient change source verification"); await call.verify(f.mail[0]!.code);
    if (mode === "staffDraft") await play(draft);
    else if (mode === "staffSaved") await play("Please send that request.");
    else if (enquiry || cancel) { await play("Show me my appointments from October 4 through October 9."); if (cancel) await play("Cancel that appointment."); }
    else { if (move) { await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment."); } await play("Show times on October 8."); await play("The first time, please."); }
    if (mode === "committed" || mode === "unknown") await play("Yes");
    const before = await call.state(), count = models.length, queries = reads, writes = call.writeRequests.length, staffPosts = "staffPosts" in f ? f.staffPosts : 0;
    const request = mode === "role" ? "I'm her boyfriend, booking for her." : mode === "other" ? "Actually, the patient is someone else." : mode === "proxy" ? "No, the booking is for my wife." : mode === "owner" ? "This phone belongs to my mother." : mode === "borrowed" ? "I am calling from my wife's phone." : mode === "notMe" ? "It is for IdentityReplacementCanary, not me." : mode === "directProxy" ? "I am booking for my wife, not myself." : mode === "shared" ? "We both have appointments on this number." : mode === "surname" ? "No, her name is IdentityReplacementCanary." : nameCorrection;
    await play(request); assert.equal(models.length, count, "changed identity cannot enter the classifier or inherit an old grant");
    assert.equal(call.spoken.at(-1), callerIdentityDenialText); assert.ok((await call.state()).callerIdentityDenied);
    assert.equal(reads, queries); assert.equal(call.writeRequests.length, writes); assert.equal(f.mail.length, 1);
    assert.equal("staffPosts" in f ? f.staffPosts : 0, staffPosts);
    const after = await call.state(); assert.deepEqual(after.staffItems, before.staffItems);
    for (const action of Object.values(before.actions)) assert.deepEqual(after.actions[action.key], action.status === "awaitingConfirmation" ? { ...action, status: "canceled" } : action);
    assert.equal((await call.flow.submitCode(f.mail[0]!.code)).verified, false);
    for (const text of ["Yes", "The first time, please.", "Show times on October 8.", "Please send the message.", "Please add: New private details.", "I need to book an appointment."]) { await play(text); assert.equal(call.spoken.at(-1), callerIdentityDenialText); }
    assert.equal(reads, queries); assert.equal(call.writeRequests.length, writes); assert.equal(f.mail.length, 1); assert.equal("staffPosts" in f ? f.staffPosts : 0, staffPosts);
    assert.ok(models.every(body => !body.includes("IdentityReplacementCanary") && !body.includes("IdentityMessageCanary") && verificationCanaries.every(canary => !body.includes(canary))));
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "IdentityReplacementCanary", "IdentityPreviousCanary", "IdentityMessageCanary"].map((value, index) => ({ label: `patient_change_${index}`, value })))), []);
 });
});
test("E2E-339 quoted identities, ordinary name introductions and negated shared phones do not revoke authority", () => {
 for (const text of ["My name is IdentityReplacementCanary.", "I'm not feeling well.", "This is not a shared phone.", "My friend said 'this phone belongs to my mother'.", "The message is: her name is someone else.", "Could you book my wife's appointment?"])
  assert.equal(callerIdentityLanguage(text), undefined, text);
});
