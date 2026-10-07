import assert from "node:assert/strict";
import test from "node:test";
import { specialServiceLanguage } from "../../src/standalone/special-service-language.ts";
import { requestBoundaryLanguage } from "../../src/standalone/request-boundary-language.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoStaffCallFlowFixture } from "../support/cliniko-staff-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const questions = ["Can you book me into a Pilates class?", "Can you switch my mat class from 18:05 to 19:05 tonight?", "I have a membership pass. Can you book the 19:05 mat class?", "Avery will not attend gym class today.", "I need a home visit.", "Can you book a home visit for foot treatment?", "Cancel my home visit appointment.", "Please change my appointment to telehealth.", "Please change my appointment to in person.", "Can I attend my appointment virtually?", "Move my appointment to another practitioner.", "Can I reschedule with Demo B instead?", "Can you switch my class tonight?", "I already have a mat pass. Book the Pilates class tonight."];
const modes = [...questions.map((_, i) => `question${i}`), "pending", "committed", "unknown", "cancelSource", "moveSource", "staffClass", "staffHome"];
test("E2E-347 special service requests cannot become ordinary bookings; exact supported changes preserve source and independently approved service", { timeout: 180_000 }, async () => {
 await withDisposablePostgres(async db => {
  const failures: unknown[] = [];
  const run = async (mode: string, index: number) => {
   const staff = mode.startsWith("staff") ? await clinikoStaffCallFlowFixture() : undefined;
   const move = mode === "moveSource" ? await reschedulingCallFlowFixture({ multiple: true }) : undefined;
   const cancel = mode === "cancelSource" ? await cancellationCallFlowFixture({ multiple: true }) : undefined;
   const f = staff ?? move ?? cancel ?? await bookingCallFlowFixture(); f.flow.dispose(); if (move) move.setStarts(["2026-10-08T05:00:00.000Z"]);
   const sent = mode === "committed" || mode === "unknown";
   let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined; const models: string[] = [], paths: string[] = []; let traffic = 0;
   try {
    const port = f.flowConfig.fetchPort!;
    call = await clinikoWorkflowVoiceFixture(db, { ...f.flowConfig, fetchPort: async (...args) => { traffic++; paths.push(`${args[1]?.method ?? "GET"} ${new URL(String(args[0])).pathname}`); return port(...args); } }, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
     models.push(String(init?.body)); const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
     const start = ["I need to book an appointment.", "I need to cancel an appointment.", "I need to move an appointment."].includes(text), targets = text === "Show my existing appointments from October 4 through October 9.", appointments = text === "Show my appointments from October 4 through October 9.", menu = text === "Show times on October 8." || text === "Show move times on October 8.";
     const decision = { kind: appointments ? "appointments" : targets || menu ? "menu" : "workflow", operation: start ? move ? "reschedule" : cancel ? "cancel" : "book" : targets || menu || appointments ? null : "book", stage: targets ? "targets" : move && menu ? "offers" : null, from: targets || appointments ? "2026-10-04" : menu ? "2026-10-08" : null, to: targets || appointments ? "2026-10-09" : menu ? "2026-10-08" : null, choice: null };
     return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
    } }), { lostWrite: mode === "unknown" });
    const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
    if (staff) { await play("I would like to leave a detailed message."); await voiceUntil(() => f.mail.length === 1, "special service message proof"); await call.verify(f.mail[0]!.code); await play(mode === "staffClass" ? "The message is: SpecialServiceMessageCanary I cannot attend the Pilates class tonight and need reception to advise." : "The message is: SpecialServiceMessageCanary please ask reception to arrange a home visit."); }
    else if (mode === "pending" || sent || move || cancel) {
     await play(move ? "I need to move an appointment." : cancel ? "I need to cancel an appointment." : "I need to book an appointment."); await voiceUntil(() => f.mail.length === 1, "special service operation proof"); await call.verify(f.mail[0]!.code);
     if (move) { await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment."); }
     await play(cancel ? "Show my appointments from October 4 through October 9." : move ? "Show move times on October 8." : "Show times on October 8."); await play(cancel ? "Cancel the first appointment." : "The first time, please."); if (sent || move || cancel) await play("Yes");
    }
    if (move || cancel) {
     assert.equal(call.writeRequests.length, 1); assert.equal(call.writeRequests[0]!.method, "PATCH"); assert.equal(call.writeRequests[0]!.path, cancel ? "/v1/individual_appointments/91/cancel" : "/v1/individual_appointments/91"); assert.ok(!paths.some(path => path.startsWith("PATCH ") && path.includes("/92")));
     if (move) { assert.equal(call.writeRequests[0]!.body.starts_at, "2026-10-08T05:00:00.000Z"); const action = Object.values((await call.state()).actions).at(-1)!; if (action.mutation.request.kind !== "reschedule") throw new Error("expected exact move"); assert.equal(action.mutation.request.offer.presentation!.durationMinutes, 30); assert.match(call.spoken.join(" "), /for 30 minutes/); }
     const writes = call.writeRequests.length; await play("Yes"); assert.equal(call.writeRequests.length, writes); return;
    }
    const before = await call.state(), reads = traffic, count = models.length, mail = f.mail.length, writes = call.writeRequests.length;
    await play(staff ? "Can you arrange that service now?" : questions[index] ?? questions[0]!);
    assert.equal(models.length, count, "special service cannot default to a classifier booking"); assert.equal(traffic, reads + (staff ? 1 : 0)); assert.equal(f.mail.length, mail); assert.equal(call.writeRequests.length, writes);
    assert.match(call.spoken.at(-1)!, staff ? /message has not been sent/ : /can't manage group-class|can't arrange.*home|can't change|can’t use/s);
    const after = await call.state(); assert.deepEqual(after.staffItems, before.staffItems); for (const action of Object.values(before.actions)) assert.deepEqual(after.actions[action.key], action.status === "awaitingConfirmation" ? { ...action, status: "canceled" } : action);
    if (mode === "pending") { await play("Yes"); assert.equal(call.writeRequests.length, 0); }
    if (staff) { await play("Please send the message."); assert.equal(staff.staffPosts, 1); assert.match(String(staff.recalls[0]!.notes), /SpecialServiceMessageCanary/); assert.equal(call.writeRequests.length, 0); assert.doesNotMatch(call.spoken.at(-1)!, /class.*cancelled|home visit.*booked/s); }
    assert.ok(models.every(body => !body.includes("SpecialServiceMessageCanary") && verificationCanaries.every(value => !body.includes(value))));
   } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
   finally { await call?.close(); await f.close(); }
  };
  let next = 0; const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const index = next++, mode = modes[index]; if (!mode) return; try { await run(mode, index); } catch (error) { failures.push(error); } } }));
  for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
  if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
  assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, "SpecialServiceMessageCanary"].map((value, index) => ({ label: `special_service_${index}`, value })))), []);
 });
});

test("E2E-347 special service syntax is negative only and excludes quote/negation/mixed authority", () => {
 for (const text of questions) assert.ok(specialServiceLanguage(text) || requestBoundaryLanguage(text));
 for (const text of ["Cancel the first appointment.", "The first time, please.", "I do not need a home visit.", "My friend said 'I need a home visit'.", "Please change my appointment to telehealth and cancel my appointment.", "The message is: I need a home visit."]) { assert.equal(specialServiceLanguage(text), undefined); assert.equal(requestBoundaryLanguage(text), undefined); }
});
