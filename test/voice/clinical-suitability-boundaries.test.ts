import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { clinicalAdviceBoundary } from "../../src/standalone/clinic-information-language.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { publicServiceInformationFixture, publicServices } from "../support/public-service-information.ts";
import { urgentConversationFixture, urgentReply, urgentFallback } from "../support/urgent-conversation.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const questions = ["Can an osteopath fix recurring shoulder dislocations after a seizure?", "Will this treatment help my child's autism?", "Can the clinician perform an Epley manoeuvre on my first visit?", "Can the doctor give an injection on my first appointment?", "Should I take codeine for this pain?", "Can I stop my medication before the appointment?", "Am I eligible for a free NHS flu vaccination?", "Does being a carer mean I qualify for an NHS flu vaccination?", "Is an hour of massage suitable after my hip replacement?", "I have pain and swelling after nail surgery. Can you recommend treatment?", "Is the clinician the right person to treat my vertigo?", "Can you recommend exercises for my grandson's shoulder instability?", "Would an osteopath help my lower back after a kidney stone?"];
const modes = [...questions.map((_, i) => `question${i}`), "pending", "committed", "unknown", "denied", "urgent", "urgentMissing", "urgentExpired", "urgentForeign", "services", "servicesMissing", "staff"];
test("E2E-344 clinical suitability, procedure and vaccine eligibility questions cannot authorize medical claims or appointment defaults", { timeout: 180_000 }, async () => {
 await withDisposablePostgres(async db => {
  const failures: unknown[] = [];
  const run = async (mode: string, index: number) => {
   const urgent = mode.startsWith("urgent"), services = mode.startsWith("services"), sent = mode === "committed" || mode === "unknown";
   const info = services ? await publicServiceInformationFixture({ services: mode !== "servicesMissing" }) : undefined;
   const routing = urgent ? await urgentConversationFixture({ missing: mode === "urgentMissing" }) : undefined;
   const staff = mode === "staff" ? await clinikoStaffCallFlowFixture() : undefined;
   const f = info ?? routing ?? staff ?? await bookingCallFlowFixture(); f.flow.dispose();
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = []; let traffic = 0;
   try {
    if (mode === "urgentExpired") routing!.setUrgentOverride({ ...routing!.response, effectiveUntil: "2026-10-04T05:00:00.000Z" });
    if (mode === "urgentForeign") routing!.setUrgentOverride({ ...routing!.response, scope: { ...routing!.response.scope, clinicId: "foreign-clinic" } });
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return port(...args); } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
     const menu = text === "Show times on October 8.";
     const decision = { kind: menu ? "menu" : "workflow", operation: menu ? null : "book", stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null };
     return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }), { lostWrite: mode === "unknown" });
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    if (mode === "pending" || sent) { await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "clinical boundary proof"); await call.verify(f.mail[0]!.code); await play("Show times on October 8."); await play("The first time, please."); if (sent) await play("Yes"); }
    if (mode === "denied") await play("I am not that patient.");
    if (staff) { await play("I would like to leave a detailed message."); await voiceUntil(() => f.mail.length === 1, "clinical message proof"); await call.verify(f.mail[0]!.code); await play("The message is: ClinicalMessageCanary I have discomfort after treatment and want the clinician to advise."); }
    const before = await call.state(), reads = traffic, count = models.length, mail = f.mail.length, writes = call.writeRequests.length;
    await play(urgent ? "I need urgent medical help for pain." : services ? "What treatments do you offer?" : questions[index] ?? questions[2]!);
    assert.equal(models.length, count, "medical authority cannot come from classifier guesses"); if (!staff) assert.equal(traffic, reads); else assert.equal(traffic, reads + 1, "existing verified-patient message refresh only"); assert.equal(f.mail.length, mail); assert.equal(call.writeRequests.length, writes);
    if (urgent) assert.equal(call.spoken.at(-1), mode === "urgent" ? urgentReply : urgentFallback);
    else if (services) { if (mode === "servicesMissing") assert.match(call.spoken.at(-1)!, /can't verify approved service descriptions/); else { assert.equal(call.spoken.at(-1), publicServices); } }
    else if (staff) assert.match(call.spoken.at(-1)!, /message has not been sent/);
    else assert.match(call.spoken.at(-1)!, /can’t give medical advice/);
    const after = await call.state(); assert.deepEqual(after.staffItems, before.staffItems); for (const action of Object.values(before.actions)) assert.deepEqual(after.actions[action.key], action.status === "awaitingConfirmation" ? { ...action, status: "canceled" } : action);
    if (mode === "pending") { await play("Yes"); assert.equal(call.writeRequests.length, 0); }
    if (sent) assert.equal(Object.values(after.actions)[0]!.status, Object.values(before.actions)[0]!.status);
    if (staff) { await play("Please send the message."); assert.equal(staff.staffPosts, 1); assert.match(String(staff.recalls[0]!.notes), /ClinicalMessageCanary I have discomfort after treatment and want the clinician to advise/); assert.equal(call.writeRequests.length, 0); }
    assert.ok(models.every(body => !body.includes("ClinicalMessageCanary") && verificationCanaries.every(value => !body.includes(value))));
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const index = next++, mode = modes[index]; if (!mode) return; try { await run(mode, index); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "ClinicalMessageCanary"].map((value, index) => ({ label: `clinical_boundary_${index}`, value })))), []);
 });
});

test("E2E-344 bounded clinical routing supplies no inferred suitability, eligibility or diagnosis", () => {
 for (const text of questions) assert.equal(clinicalAdviceBoundary(text)?.kind, "clarify", text);
 for (const text of ["What services do you offer?", "I am not asking whether I qualify for a vaccination.", "My friend said 'can the clinician perform an Epley manoeuvre on my first visit'.", "Can you recommend exercises and cancel my appointment?", "The message is: Can the clinician perform an Epley manoeuvre on my first visit?"])
  assert.equal(clinicalAdviceBoundary(text), undefined, text);
});
