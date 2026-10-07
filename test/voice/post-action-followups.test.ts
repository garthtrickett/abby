import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { clarificationText } from "../../src/core/clarification.ts";
import { oldAppointmentCancellation } from "../../src/standalone/appointment-change-language.ts";

test("E2E-334 follow-ups preserve real booking and move receipts without canceling a replacement or claiming an unbooked visit", { timeout: 120_000 }, async () => {
  await withDisposablePostgres(async db => {
    const modes = ["bookCancel", "bookDont", "bookQuestion", "moveOld", "moveOriginal", "moveUnknown", "unsentOld", "unsentBook"] as const;
    const failures: unknown[] = [];
    const run = async (mode: typeof modes[number]) => {
      const move = mode.startsWith("move") || mode === "unsentOld", unsent = mode.startsWith("unsent");
      const f = move ? await reschedulingCallFlowFixture() : await bookingCallFlowFixture(); f.flow.dispose();
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      const modelBodies: string[] = [];
      try {
        call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
          apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_url, init) => {
            modelBodies.push(String(init?.body));
            const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
            const start = text === "I need to book an appointment." || text === "I need to move an appointment.";
            const targets = text === "Show my existing appointments from October 4 through October 9.";
            const menu = text === "What times are available on October 8?" || text === "Show move times on October 8.";
            const decision = { kind: start ? "workflow" : targets || menu ? "menu" : "unsupported", operation: start ? move ? "reschedule" : "book" : null,
              stage: targets ? "targets" : move && menu ? "offers" : null,
              from: targets ? "2026-10-04" : menu ? "2026-10-08" : null, to: targets ? "2026-10-09" : menu ? "2026-10-08" : null, choice: null };
            return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
          } }), { lostWrite: mode === "moveUnknown" });
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        await play(move ? "I need to move an appointment." : "I need to book an appointment.");
        await voiceUntil(() => f.mail.length === 1, "private operation verification"); await call.verify(f.mail[0]!.code);
        if (move) { await play("Show my existing appointments from October 4 through October 9."); await play("My first existing appointment."); }
        await play(move ? "Show move times on October 8." : "What times are available on October 8?");
        await play("The first time, please.");
        if (!unsent) await play("Yes");
        const before = await call.state(), action = Object.values(before.actions).at(-1)!;
        assert.equal(action.status, unsent ? "awaitingConfirmation" : mode === "moveUnknown" ? "uncertain" : "committed");
        assert.equal(call.writeRequests.length, unsent ? 0 : 1);
        if (!unsent) {
          assert.equal(call.writeRequests[0]?.method, move ? "PATCH" : "POST");
          assert.equal(call.writeRequests[0]?.path, move ? "/v1/individual_appointments/91" : "/v1/individual_appointments");
          assert.equal(call.writeRequests[0]?.body.starts_at, move ? "2026-10-08T05:00:00.000Z" : "2026-10-08T04:00:00.000Z");
          if (!move) assert.equal(call.writeRequests[0]?.body.patient_id, verificationCanaries[2]);
        }
        const followup = mode === "bookDont" || mode === "unsentBook" ? "Don't book it."
          : mode === "bookCancel" ? "Cancel that appointment."
          : mode === "bookQuestion" ? "Could you email me proof of that booking?"
          : mode === "moveOriginal" ? "Please cancel my original appointment."
          : "So I'd like to cancel my old appointment, please.";
        const modelCount = modelBodies.length;
        await play(followup);
        assert.ok(call.transcripts.includes(followup), "the follow-up must reach an owned final transcript");
        if (!unsent) assert.equal(modelBodies.length, modelCount, "actual receipt follow-up uses no classifier guess");
        const after = await call.state();
        assert.equal(call.writeRequests.length, unsent ? 0 : 1); assert.equal(call.writes.length, unsent ? 0 : 1);
        assert.equal(f.mail.length, 1); assert.deepEqual(after.staffItems, before.staffItems);
        if (unsent) {
          assert.equal(after.actions[action.key]?.status, "canceled");
          assert.doesNotMatch(call.spoken.at(-1)!, /already (?:been )?moved|booking is confirmed|move is confirmed|replacement/);
        } else {
          assert.deepEqual(after.actions, before.actions); assert.deepEqual(after.effects, before.effects);
          if (move && mode !== "moveUnknown") assert.equal(call.spoken.at(-1), "Your original appointment has already been moved to the confirmed new time. I haven't canceled the replacement appointment. Please contact the clinic if you want to change or cancel that appointment.");
          else if (mode === "moveUnknown") {
            assert.match(call.spoken.at(-1)!, /can't confirm the previous action yet/);
            assert.doesNotMatch(call.spoken.at(-1)!, /already (?:been )?moved|move is confirmed/);
          } else assert.match(call.spoken.at(-1)!, /^Your booking is confirmed\./);
          assert.doesNotMatch(call.spoken.at(-1)!, /won't be booked|will not be booked|appointment has been cancel|appointment is cancel/i);
          await play("Cancel that appointment.");
          assert.deepEqual((await call.state()).actions, before.actions); assert.equal(call.writeRequests.length, 1);
        }
        assert.ok(modelBodies.every(body => verificationCanaries.every(canary => !body.includes(canary))));
      } catch (error) { throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      finally { await call?.close(); await f.close(); }
    };
    let next = 0;
    const settled = await Promise.allSettled(Array.from({ length: 3 }, async () => { for (;;) { const mode = modes[next++]; if (!mode) return; try { await run(mode); } catch (error) { failures.push(error); } } }));
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
    assert.deepEqual(resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `post_action_${index}`, value })))), []);
  });
});

test("E2E-334 caller wording cannot establish a moved appointment or select a replacement for cancellation", () => {
  for (const text of ["Don't cancel my old appointment.", "I said 'cancel my old appointment'.", "Cancel my old appointment and book another.",
    "Cancel my wife's original appointment.", "Could you cancel my old appointment if the new one is booked?"])
    assert.equal(oldAppointmentCancellation(text), false, text);
  for (const status of ["awaitingConfirmation", "ready", "canceled", "rejected"] as const)
    assert.equal(clarificationText("oldAppointmentAfterMove", { kind: "reschedule", status }),
      "Let's check which appointment you mean before changing anything. Please request your appointments again.");
  for (const status of ["uncertain", "needsReview", "dispatched"] as const) {
    const reply = clarificationText("oldAppointmentAfterMove", { kind: "reschedule", status });
    assert.match(reply, /^I can't confirm the previous action yet\./);
    assert.doesNotMatch(reply, /already.*moved|replacement|move is confirmed/);
  }
  const booking = clarificationText("oldAppointmentAfterMove", { kind: "book", status: "committed" });
  assert.match(booking, /^Your booking is confirmed\./); assert.doesNotMatch(booking, /already.*moved|replacement/);
  assert.doesNotMatch(clarificationText("oldAppointmentAfterMove"), /already.*moved|replacement/);
});
