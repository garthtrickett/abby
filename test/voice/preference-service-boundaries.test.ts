import assert from "node:assert/strict";
import test from "node:test";
import { serviceConstraintLanguage } from "../../src/standalone/service-constraint-language.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCatalogueFixture } from "../support/cliniko-booking-catalogue.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const questions = ["I would prefer a female physiotherapist.", "A female physiotherapist, please.", "Can I see a male therapist?", "Who did I see last time?", "Please book me with the practitioner I saw last time.", "Who is the best therapist?", "Can you recommend the best practitioner for my injury?", "Book me with the practitioner who has the same approach as my old osteopath.", "I want a 60-minute appointment.", "Can I have a 90-minute appointment instead?", "Please change the appointment duration to one hour.", "I want a different appointment type.", "I need treatment for both foot pain and a corn."];
const modes = [...questions.map((_, i) => `question${i}`), "pending", "committed", "unknown", "staff", "primary", "preferred", "any", "alias"];
test("E2E-346 unsupported gender, history, style, service and duration cannot fall back to a default; exact approved practitioners preserve native type/duration", { timeout: 180_000 }, async () => {
 await withDisposablePostgres(async db => {
  const failures: unknown[] = [];
  const run = async (mode: string, index: number) => {
   const supported = ["primary", "preferred", "any"].includes(mode), sent = mode === "committed" || mode === "unknown";
   const staff = mode === "staff" ? await clinikoStaffCallFlowFixture() : undefined;
   const catalogue = staff ? undefined : await bookingCatalogueFixture(); const f = staff ?? catalogue!; f.flow.dispose();
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = []; let traffic = 0;
   try {
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; return port(...args); } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText, menu = text === "Show times on October 8.";
     const decision = { kind: menu ? "menu" : "workflow", operation: menu ? null : "book", stage: null, from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null };
     return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }), { lostWrite: mode === "unknown" });
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    if (staff) { await play("I would like to leave a detailed message."); await voiceUntil(() => f.mail.length === 1, "preference message proof"); await call.verify(f.mail[0]!.code); await play("The message is: PreferenceMessageCanary please help me identify my previous practitioner and an appropriate appointment duration."); }
    else { await play("I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "preference proof"); await call.verify(f.mail[0]!.code); if (!supported) await play("Show times on October 8."); if (mode === "pending" || sent) { await play("The first time, please."); if (sent) await play("Yes"); } }
    const before = await call.state(), reads = traffic, count = models.length, mail = f.mail.length, writes = call.writeRequests.length;
    const request = mode === "primary" ? "I prefer Demo A." : mode === "preferred" ? "I prefer Demo B." : mode === "any" ? "Anyone is fine. What is the soonest opening?" : mode === "alias" ? "I prefer Demo Bee." : staff ? questions[3]! : questions[index] ?? questions[0]!;
    await play(request); assert.equal(models.length, count, "preferences cannot come from classifier guesses"); if (!supported && mode !== "alias") assert.equal(traffic, reads + (staff ? 1 : 0)); assert.equal(f.mail.length, mail); assert.equal(call.writeRequests.length, writes);
    if (supported) {
     assert.match(call.spoken.at(-1)!, /Demo North/); await play("The first time, please."); const action = Object.values((await call.state()).actions).at(-1)!;
     assert.equal(action.status, "awaitingConfirmation"); if (action.mutation.request.kind !== "book") throw new Error("expected native booking"); const detail = action.mutation.request.offer.presentation!;
     assert.equal(detail.durationMinutes, catalogue!.approval.durationMinutes); assert.match(call.spoken.at(-1)!, new RegExp(`for ${detail.durationMinutes} minutes`));
     await play("Yes"); assert.equal(call.writeRequests.length, 1); const body = call.writeRequests[0]!.body; assert.equal(body.practitioner_id, mode === "primary" ? "22" : "23"); assert.equal(body.appointment_type_id, "33"); assert.equal(body.business_id, "11"); assert.equal(body.starts_at, action.mutation.request.offer.startsAt); assert.equal((await call.state()).actions[action.key]!.status, "committed"); await play("Yes"); assert.equal(call.writeRequests.length, 1);
    } else {
     assert.match(call.spoken.at(-1)!, staff ? /message has not been sent/ : /can’t use|can't change|can’t give medical advice/);
     const after = await call.state(); assert.deepEqual(after.staffItems, before.staffItems); for (const action of Object.values(before.actions)) assert.deepEqual(after.actions[action.key], action.status === "awaitingConfirmation" ? { ...action, status: "canceled" } : action);
     if (mode === "pending" || mode === "alias") { await play("Yes"); assert.equal(call.writeRequests.length, writes); }
     if (staff) { await play("Please send the message."); assert.equal(staff.staffPosts, 1); assert.match(String(staff.recalls[0]!.notes), /PreferenceMessageCanary/); assert.equal(call.writeRequests.length, 0); }
    }
    assert.ok(models.every(body => !body.includes("PreferenceMessageCanary") && verificationCanaries.every(value => !body.includes(value))));
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const index = next++, mode = modes[index]; if (!mode) return; try { await run(mode, index); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "PreferenceMessageCanary"].map((value, index) => ({ label: `preference_boundary_${index}`, value })))), []);
 });
});

test("E2E-346 service constraints never supply positive catalogue metadata", () => {
 for (const question of questions) assert.ok(serviceConstraintLanguage(question));
 for (const text of ["I prefer Demo B.", "Anyone is fine.", "I do not prefer a female therapist.", "My friend said 'who is the best therapist'.", "I want a 60-minute appointment and cancel my appointment.", "The message is: Who did I see last time?"]) assert.equal(serviceConstraintLanguage(text), undefined);
});
