import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { serviceBookingFixture } from "../support/service-booking-catalogue.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-348 signed guided service dialogue requires played questions, current approval and explicit return answers", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const cases = ["initial", "followUp", "newProblem", "newPatient", "overdue", "revoked", "changedSource", "interrupted", "correction", "unsupportedDuration"] as const;
    let next = 0;
    const failures: unknown[] = [];
    await Promise.all(Array.from({ length: 2 }, async () => {
      for (;;) {
        const mode = cases[next++]; if (!mode) return;
        const f = await serviceBookingFixture(); f.flow.dispose();
        let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
        const models: string[] = [];
        try {
          call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
            clinicDate: () => "2026-10-04", fetch: async (_input, init) => {
              const value = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; models.push(value);
              assert.equal(value, "Show times on October 8.");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
                text: JSON.stringify({ kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null }) }] }] });
            } }), { appointmentTypeMetadata: { "33": { durationMinutes: 30 }, "34": { durationMinutes: 60 }, "35": { durationMinutes: 45 }, "36": { durationMinutes: 45 } } });
          const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
          await call.turn("I'd like to book an appointment.");
          assert.match(call.spoken.at(-1)!, /Which service.*Physiotherapy.*Massage/);
          assert.equal(f.mail.length, 0);
          if (mode === "interrupted") {
            await call.turn("Physiotherapy.", { interrupt: true }); await call.mark();
            assert.match(call.spoken.at(-1)!, /choose the service.*again/);
            assert.equal(f.mail.length, 0); assert.equal(call.writeRequests.length, 0); continue;
          }
          await call.mark();
          if (mode === "revoked" || mode === "changedSource") {
            await f.replaceServices(mode === "revoked" ? { enabled: false } : { revision: "services-2" }); await play("Physiotherapy.");
            assert.equal(f.mail.length, 0); assert.equal(call.writeRequests.length, 0); continue;
          }
          await play("Physiotherapy."); assert.match(call.spoken.at(-1)!, /initial assessment.*follow-up|follow-up.*initial assessment/);
          const follow = ["followUp", "newProblem", "newPatient", "overdue", "correction"].includes(mode);
          await play(follow ? "Follow-up." : "I've never been.");
          assert.match(call.spoken.at(-1)!, /appointment length/);
          if (mode === "unsupportedDuration") {
            await play("90 minutes."); assert.match(call.spoken.at(-1)!, /45.*60 minutes/); assert.equal(f.mail.length, 0);
          }
          await play(follow ? "Half an hour." : "One hour.");
          if (follow) {
            assert.match(call.spoken.at(-1)!, /attended this clinic before/); assert.equal(f.mail.length, 0);
            if (mode === "correction") {
              await play("Actually, an initial assessment."); assert.match(call.spoken.at(-1)!, /appointment length/);
              await play("One hour.");
            } else {
              await play(mode === "newPatient" ? "No." : "Yes.");
              if (mode === "newPatient") {
                assert.match(call.spoken.at(-1)!, /choose the service.*again/); assert.equal(f.mail.length, 0); continue;
              }
              assert.match(call.spoken.at(-1)!, /new problem/); assert.equal(f.mail.length, 0);
              await play(mode === "newProblem" ? "Yes." : "No.");
              if (mode === "newProblem") {
                assert.match(call.spoken.at(-1)!, /choose the service.*again/); assert.equal(f.mail.length, 0); continue;
              }
              assert.match(call.spoken.at(-1)!, /How many months/); assert.equal(f.mail.length, 0);
              await play(mode === "overdue" ? "4 months ago." : "2 months ago.");
              if (mode === "overdue") {
                assert.match(call.spoken.at(-1)!, /choose the service.*again/); assert.equal(f.mail.length, 0); continue;
              }
            }
          }
          assert.equal(models.length, 0, "service and return facts must not reach the classifier");
          await voiceUntil(() => f.mail.length === 1, "guided service verification");
          await call.verify(f.mail[0]!.code); await play("Show times on October 8."); await play("The first time, please.");
          assert.match(call.spoken.at(-1)!, mode === "followUp" ? /Physiotherapy follow-up.*30 minutes/ : /Physiotherapy initial.*60 minutes/);
          await play("Yes."); assert.equal(call.writeRequests.length, 1);
          assert.equal(call.writeRequests[0]!.body.appointment_type_id, mode === "followUp" ? "33" : "34");
          assert.equal(Object.values((await call.state()).actions).at(-1)!.status, "committed");
          await play("I'd like to book an appointment."); assert.equal(f.mail.length, 1); assert.equal(call.writeRequests.length, 1);
        } catch (error) { failures.push(new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        finally { await call?.close(); await f.close(); }
      }
    }));
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
    assert.deepEqual(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `guided_${index}`, value }))), { ok: true, value: [] });
  });
});
