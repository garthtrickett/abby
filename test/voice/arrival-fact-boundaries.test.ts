import assert from "node:assert/strict";
import test from "node:test";
import { arrivalInformationLanguage } from "../../src/standalone/arrival-information-language.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { bookingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinicFAQFixture, publicDirections } from "../support/clinic-faqs.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries, verificationNow } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const questions = ["I have arrived for my appointment but the door is locked.", "The intercom is inaccessible because of roadworks.", "There is no intercom I can use.", "The gate is being dug up and I cannot get inside.", "The entrance step is not accessible to my wheelchair.", "I arrived for my appointment and nobody is here.", "Your website and confirmation email give different addresses.", "You gave me conflicting opening hours.", "The clinic address you gave me is wrong."];
const sources = ["directions", "hours", "duplicateDirections", "duplicateHours", "changed", "expired", "revoked", "missing"];
const modes = [...questions.map((_, i) => `question${i}`), "pending", "committed", "unknown", "denied", "staff", ...sources];
test("E2E-345 unusable arrival instructions and conflicting public facts cannot become access promises or invented details", { timeout: 180_000 }, async () => {
 await withDisposablePostgres(async db => {
  const failures: unknown[] = [];
  const run = async (mode: string, index: number) => {
   const source = sources.includes(mode), sent = mode === "committed" || mode === "unknown";
   const info = source ? await clinicFAQFixture() : undefined;
   const staff = mode === "staff" ? await clinikoStaffCallFlowFixture() : undefined;
   const f = info ?? staff ?? await bookingCallFlowFixture(); f.flow.dispose();
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = []; let traffic = 0;
   try {
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return port(...args); } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText, menu = text === "Show times on October 8.";
     const decision = { kind: source ? "faq" : menu ? "menu" : "workflow", operation: source || menu ? null : "book", stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: source ? mode === "hours" ? 2 : 1 : null };
     return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }), { lostWrite: mode === "unknown" });
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    if (mode === "pending" || sent) { await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "arrival proof"); await call.verify(f.mail[0]!.code); await play("Show times on October 8."); await play("The first time, please."); if (sent) await play("Yes"); }
    if (mode === "denied") await play("I am not that patient.");
    if (info) {
     if (mode === "duplicateDirections" || mode === "duplicateHours") { const topic = mode === "duplicateHours" ? "openingHours" : "directionsAndParking"; await info.replaceFAQs({ facts: [...info.faqApproval.facts, { topic, approvedText: "ConflictingFactCanary a competing approved detail." }] }); }
     if (mode === "changed") { await play("Where is the clinic entrance?"); assert.equal(call.spoken.at(-1), publicDirections); await info.replaceFAQs({ facts: info.faqApproval.facts.map(fact => fact.topic === "directionsAndParking" ? { ...fact, approvedText: "ChangedFactCanary the entrance is now on Changed Lane." } : fact) }); }
     if (mode === "expired") await info.replaceFAQs({ effectiveUntil: verificationNow });
     if (mode === "revoked") await info.replaceFAQs({ approved: false });
     if (mode === "missing") await info.replaceFAQs({ facts: [] });
    }
    if (staff) { await play("I would like to leave a detailed message."); await voiceUntil(() => f.mail.length === 1, "arrival message proof"); await call.verify(f.mail[0]!.code); await play("The message is: ArrivalMessageCanary I am outside and roadworks block the intercom."); }
    const before = await call.state(), reads = traffic, count = models.length, mail = f.mail.length, writes = call.writeRequests.length;
    await play(staff ? "Can you open the door for me?" : source ? mode === "hours" || mode === "duplicateHours" ? "When do you open?" : "Where is the clinic entrance?" : questions[index] ?? questions[0]!);
    assert.equal(models.length, count + (source ? 1 : 0), "barrier claims cannot become classifier booking guesses"); if (!staff) assert.equal(traffic, reads); else assert.equal(traffic, reads + 1, "verified-patient message refresh only"); assert.equal(f.mail.length, mail); assert.equal(call.writeRequests.length, writes);
    if (source) assert.equal(call.spoken.at(-1), mode === "directions" ? publicDirections : mode === "hours" ? info!.faqApproval.facts[1]!.approvedText : "I can't verify that information right now.");
    else if (staff) assert.match(call.spoken.at(-1)!, /message has not been sent/);
    else assert.match(call.spoken.at(-1)!, /can't verify (?:access|those conflicting)/);
    const after = await call.state(); if (source) { for (const item of Object.values(after.staffItems)) { assert.equal(item.reason, "systemFailure"); assert.equal(item.status, "needsReview"); } } else assert.deepEqual(after.staffItems, before.staffItems); for (const action of Object.values(before.actions)) assert.deepEqual(after.actions[action.key], action.status === "awaitingConfirmation" ? { ...action, status: "canceled" } : action);
    if (mode === "pending") { await play("Yes"); assert.equal(call.writeRequests.length, 0); }
    if (staff) { await play("Please send the message."); assert.equal(staff.staffPosts, 1); assert.match(String(staff.recalls[0]!.notes), /ArrivalMessageCanary I am outside and roadworks block the intercom/); assert.equal(call.writeRequests.length, 0); }
    assert.ok(models.every(body => !body.includes("ArrivalMessageCanary") && !body.includes("ChangedFactCanary") && !body.includes("ConflictingFactCanary") && verificationCanaries.every(value => !body.includes(value))));
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const index = next++, mode = modes[index]; if (!mode) return; try { await run(mode, index); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "ArrivalMessageCanary"].map((value, index) => ({ label: `arrival_boundary_${index}`, value })))), []);
 });
});

test("E2E-345 arrival reports cannot infer access from quoted, negated or mixed requests", () => {
 for (const question of questions) assert.ok(arrivalInformationLanguage(question));
 for (const text of ["The door is not locked.", "My friend said 'the door is locked'.", "Open the door and cancel my appointment.", "The message is: I have arrived for my appointment but the door is locked."]) assert.equal(arrivalInformationLanguage(text), undefined);
});
