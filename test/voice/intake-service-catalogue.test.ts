import assert from "node:assert/strict";
import test from "node:test";
import { intakeServiceFixture } from "../support/intake-service-catalogue.ts";
import { intakeDraft } from "../support/intake-edge.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";

test("E2E-353 new-patient service variants require played selection, private registration and separate exact booking", { timeout: 180000 }, async () => {
  await withDisposablePostgres(async db => {
    const cases = ["direct", "guided", "routed", "unplayed", "durationCorrection", "durationUnavailable", "massage", "gender", "followUp", "revoked", "bookingRevoked", "durationDrift", "groupFailure", "bookPermission", "intakeLoss", "bookingLoss"] as const;
    let next = 0; const failures: unknown[] = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (;;) {
        const mode = cases[next++]; if (!mode) return;
        const f = await intakeServiceFixture(); f.flow.dispose();
        let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined, step = "setup";
        try {
          call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              assert.ok(["I need to register before arranging my first visit.", "Save my details.", "Show times on October 8."].includes(text));
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
                text: JSON.stringify(text === "I need to register before arranging my first visit." ? { kind: "workflow", operation: "intake", stage: null, from: null, to: null, choice: null } : text === "Save my details." ? { kind: "save", operation: null, stage: null, from: null, to: null, choice: null }
                  : { kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null }) }] }] });
            } }), { lostWrite: mode === "bookingLoss", appointmentTypeMetadata: { "34": { durationMinutes: 60 }, "35": { durationMinutes: 45 }, "36": { durationMinutes: 45 } } });
          const play = async (text: string) => { step = text; await call!.turn(text); await call!.mark(); };
          if (["guided", "gender", "groupFailure", "routed", "unplayed"].includes(mode)) {
            const starter = mode === "routed" ? "I need to register before arranging my first visit." : "I'm a new patient. I'd like to book an appointment.";
            if (mode === "unplayed") {
              await call.turn(starter); await call.turn("Physiotherapy.", { interrupt: true }); await call.mark();
              assert.equal(f.mail.length, 0); assert.equal(f.provider.patientPosts, 0); assert.equal(call.flow.workflow, undefined); continue;
            }
            await play(starter);
            assert.equal(f.mail.length, 0); assert.equal(f.provider.patientPosts, 0);
            await play("Physiotherapy."); await play("Initial assessment.");
            if (mode === "guided") { await play("Actually, Massage."); await play("Initial assessment."); await play("Forty-five minutes."); }
            else await play("One hour.");
            await play(mode === "gender" ? "A female practitioner, please." : "Anyone, please.");
          } else await play(mode === "followUp" ? "I'm a new patient. Book a 30-minute follow-up Physiotherapy appointment."
            : mode === "massage" ? "I'm a new patient. Book a 45-minute initial Massage appointment."
              : "I'm a new patient. Book a 60-minute initial Physiotherapy appointment.");
          if (mode === "followUp") { assert.equal(f.mail.length, 0); assert.equal(f.provider.patientPosts, 0); assert.equal(call.writeRequests.length, 0); continue; }
          assert.equal(call.flow.workflow, "intake"); assert.equal(f.mail.length, 0);
          const collect = async (mailNumber: number) => {
            const voice = call; assert.ok(voice);
          await voice.privateDigit("1"); await voice.mark();
          await voiceUntil(() => voice.spoken.at(-1)!.includes("Press one to acknowledge"), "recovery acknowledgment");
          await voice.mark(); await voice.privateDigit("1"); await voice.mark();
          for (const field of [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test"]) { await voice.privateField(field); await voice.mark(); }
          await voiceUntil(() => f.mail.length === mailNumber && voice.spoken.at(-1)!.includes("six digits on the keypad"), "prospective patient email verification"); await voice.mark(); await voice.verify(f.mail[mailNumber - 1]!.code);
          };
          await collect(1);
          if (mode === "durationCorrection" || mode === "durationUnavailable") {
            await play(mode === "durationCorrection" ? "I want a 45-minute appointment." : "I want an hour and a half appointment.");
            assert.equal(f.provider.patientPosts, 0);
            if (mode === "durationUnavailable") { await play("Yes."); assert.equal(f.provider.patientPosts, 0); assert.equal(call.writeRequests.length, 0); continue; }
            assert.equal(call.flow.intakeDraftRef, undefined); await collect(2);
          }
          await play("Save my details."); assert.equal(f.provider.patientPosts, 0); assert.equal(call.writeRequests.length, 0);
          if (mode === "revoked") await f.replaceServices({ enabled: false });
          if (mode === "intakeLoss") f.provider.fail("intakeLoss");
          await play("Yes.");
          if (mode === "revoked") { assert.equal(f.provider.patientPosts, 0); assert.equal(call.writeRequests.length, 0); continue; }
          assert.equal(f.provider.patientPosts, 1); assert.equal(call.writeRequests.length, 0);
          if (mode === "intakeLoss") { await play("I'm a new patient. Book a 60-minute initial Physiotherapy appointment."); assert.equal(f.provider.patientPosts, 1); assert.equal(call.writeRequests.length, 0); continue; }
          if (mode === "bookingRevoked") await f.replaceServices({ enabled: false });
          if (mode === "durationDrift") f.types.set("34", { name: "Physiotherapy initial", duration: 30 });
          if (mode === "groupFailure") f.failMember("23");
          if (mode === "bookPermission") f.setPermitted(false);
          await play("Show times on October 8.");
          if (["bookingRevoked", "durationDrift", "groupFailure", "bookPermission"].includes(mode)) { assert.equal(call.writeRequests.length, 0); assert.equal(f.provider.patientPosts, 1); continue; }
          await play("The first time, please."); assert.equal(call.writeRequests.length, 0);
          await play("Yes."); assert.equal(call.writeRequests.length, 1); assert.equal(f.provider.patientPosts, 1);
          assert.equal(call.writeRequests[0]!.body.patient_id, "42"); assert.equal(call.writeRequests[0]!.body.appointment_type_id, ["massage", "guided"].includes(mode) ? "36" : mode === "durationCorrection" ? "35" : "34");
          assert.equal(call.writeRequests[0]!.body.practitioner_id, ["gender", "routed"].includes(mode) ? "24" : "22");
          assert.equal(f.mail.length, mode === "durationCorrection" ? 2 : 1, "registration never borrows returning-patient lookup or starts a second challenge");
          const state = await call.state(); assert.equal(Object.values(state.actions).filter(action => action.kind === "intake").length, 1);
          const ordinary = JSON.stringify([call.transcripts, call.modelTurns, state.callerMessages]);
          for (const value of [intakeDraft.firstName, intakeDraft.email, intakeDraft.dateOfBirth, f.mail[0]!.code]) assert.equal(ordinary.includes(value), false);
          await play("I'm a new patient. Book a 45-minute initial Massage appointment."); assert.equal(f.provider.patientPosts, 1); assert.equal(call.writeRequests.length, 1);
        } catch (error) { failures.push(new Error(`${mode} at ${step}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        finally { await call?.close(); await f.close(); }
      }
    }));
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
    assert.deepEqual(await scanPatientDataCanaries(db, [intakeDraft.firstName, intakeDraft.email, intakeDraft.dateOfBirth].map((value, index) => ({ label: `intake_service_${index}`, value }))), { ok: true, value: [] });
  });
});
