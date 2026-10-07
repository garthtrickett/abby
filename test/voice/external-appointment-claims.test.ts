import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { requestBoundaryLanguage } from "../../src/standalone/request-boundary-language.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { appointmentEnquiryFixture } from "../support/cliniko-appointment-enquiry.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const notice = "I can't confirm a change made elsewhere or on an earlier call from that statement. A fresh verified appointment check is needed. Please ask to check your current appointments, or contact the clinic directly.";
const claims = ["I already canceled my appointment online.", "I have already cancelled my appointment directly with the provider.", "You moved my appointment on my last call.", "You booked my appointment during the previous call.", "I started booking my appointment on your website.", "The clinic changed my appointment online.", "I already canceled my appointment for tomorrow directly with the practitioner."];

test("E2E-341 external and previous-call claims cannot inherit a target or receipt; independently verified fresh reads show only current Cliniko evidence", { timeout: 180_000 }, async () => {
 await withDisposablePostgres(async db => {
  const modes = ["online", "provider", "previousMove", "previousBook", "started", "clinic", "tomorrow", "pendingBook", "pendingCancel", "pendingMove", "committed", "unknown", "fresh", "missing", "changed", "revoked", "failed", "staffDraft"] as const;
  const failures: unknown[] = [];
  const run = async (mode: typeof modes[number], index: number) => {
   const read = ["fresh", "missing", "changed", "revoked", "failed"].includes(mode), move = mode === "pendingMove", cancel = mode === "pendingCancel";
   const f = mode === "staffDraft" ? await clinikoStaffCallFlowFixture() : read ? await appointmentEnquiryFixture() : move ? await reschedulingCallFlowFixture() : cancel ? await cancellationCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose();
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = []; let traffic = 0;
   try {
    if (read && "setMultiple" in f && mode === "changed") f.setMultiple();
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return port(...args); } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
     const start = ["I need to book an appointment.", "I need to cancel an appointment.", "I need to move an appointment.", "I only want to check my appointments."].includes(text);
     const targets = text === "Show my existing appointments from October 4 through October 9.", appointments = text === "Show me my appointments from October 4 through October 9.", menu = text === "Show times on October 8.";
     // An incorrect but schema-valid classifier must not turn a historical
     // claim into a new booking or skip independently verified fresh reads.
     const historical = claims.includes(text), decision = { kind: start || historical ? "workflow" : targets || menu ? "menu" : appointments ? "appointments" : "unsupported", operation: start ? text === "I only want to check my appointments." ? "appointments.read" : move ? "reschedule" : cancel ? "cancel" : "book" : historical ? "book" : null, stage: targets ? "targets" : move && menu ? "offers" : null, from: targets || appointments ? "2026-10-04" : menu ? "2026-10-08" : null, to: targets || appointments ? "2026-10-09" : menu ? "2026-10-08" : null, choice: null };
     return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }), { lostWrite: mode === "unknown" });
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    const prepared = mode === "staffDraft" || mode.startsWith("pending") || ["committed", "unknown"].includes(mode) || read;
    if (prepared) {
     await play(mode === "staffDraft" ? "I would like to leave a detailed message." : read ? "I only want to check my appointments." : move ? "I need to move an appointment." : cancel ? "I need to cancel an appointment." : "I need to book an appointment.");
     await voiceUntil(() => f.mail.length === 1, "historical claim original verification"); await call.verify(f.mail[0]!.code);
     if (mode === "staffDraft") await play("The message is: ExternalClaimMessageCanary needs a referral update.");
     else if (read || cancel) { await play("Show me my appointments from October 4 through October 9."); if (cancel) await play("Cancel that appointment."); }
     else { if (move) { await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment."); } await play("Show times on October 8."); await play("The first time, please."); }
     if (mode === "committed" || mode === "unknown") await play("Yes");
    }
    const before = await call.state(), count = models.length, requests = traffic, writes = call.writeRequests.length, mail = f.mail.length;
    await play(mode === "pendingCancel" ? claims[6]! : claims[index] ?? claims[0]!); assert.equal(models.length, count, "external claims cannot enter the classifier"); assert.equal(traffic, requests); assert.equal(f.mail.length, mail); assert.equal(call.writeRequests.length, writes);
    assert.ok(call.spoken.at(-1)?.endsWith(notice));
    const after = await call.state();
    for (const action of Object.values(before.actions)) assert.deepEqual(after.actions[action.key], action.status === "awaitingConfirmation" ? { ...action, status: "canceled" } : action);
    if (mode === "committed" || mode === "unknown") { assert.match(call.spoken.at(-1)!, mode === "unknown" ? /can't confirm that action yet.*pending review.*won't send that action again/is : /booking is confirmed/i); assert.deepEqual(after.actions, before.actions); }
    else {
     assert.equal(call.flow.workflow, undefined); assert.equal(call.flow.verificationRequired, false); assert.equal((await call.flow.submitCode(f.mail[0]?.code ?? "000000")).verified, false);
     await play("Yes"); await play("Cancel that appointment."); await play("The first time, please."); assert.equal(call.writeRequests.length, writes); assert.equal(f.mail.length, mail);
    }
    if (read && "reads" in f) {
     const reads = f.reads;
     if (mode === "missing") f.setEmpty(); if (mode === "changed") f.setChanged(); if (mode === "failed") f.setFailure();
     await play("I only want to check my appointments."); await voiceUntil(() => f.mail.length === 2, "fresh read-specific verification"); await call.verify(f.mail[1]!.code);
     if (mode === "revoked") f.setPermitted(false);
     await play("Show me my appointments from October 4 through October 9.");
     assert.equal(call.writeRequests.length, 0); assert.equal(Object.keys((await call.state()).actions).length, 0);
     if (mode === "revoked") { assert.equal(f.reads, reads); assert.doesNotMatch(call.spoken.at(-1)!, /appointment on|Thursday 8 October/i); }
     else { assert.equal(f.reads, reads + 1); if (mode === "missing") assert.match(call.spoken.at(-1)!, /couldn't find an appointment/); else if (mode === "failed") assert.doesNotMatch(call.spoken.at(-1)!, /appointment on|Thursday 8 October/i); else if (mode === "changed") assert.match(call.spoken.at(-1)!, /option two.*5:00 pm/s); else assert.match(call.spoken.at(-1)!, /Thursday 8 October/); }
     assert.ok(f.permissionOperations.every(operation => operation === "appointments.read"));
    }
    if (mode === "staffDraft") { assert.equal(call.flow.collectingStaffMessage, false); assert.equal("staffPosts" in f ? f.staffPosts : 0, 0); }
    assert.ok(models.every(body => !body.includes("ExternalClaimMessageCanary") && verificationCanaries.every(canary => !body.includes(canary))));
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const index = next++, mode = modes[index]; if (!mode) return; try { await run(mode, index); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "ExternalClaimMessageCanary"].map((value, index) => ({ label: `external_claim_${index}`, value })))), []);
 });
});
test("E2E-341 ordinary current requests, quoted messages and denied past claims are not external-change cues", () => {
 for (const text of claims) assert.equal(requestBoundaryLanguage(text), "externalAppointmentChange", text);
 for (const text of ["Please cancel my appointment.", "I need to move an appointment.", "I have not canceled my appointment online.", "The message is: I already canceled my appointment online.", "If I canceled online, could you help?", "I already canceled my appointment online. Book another one."])
  assert.equal(requestBoundaryLanguage(text), undefined, text);
});
