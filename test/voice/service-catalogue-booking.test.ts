import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { serviceBookingFixture } from "../support/service-booking-catalogue.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-346 signed multi-service calls bind exact type/duration, reject stale authority and replace only unsent selections", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const cases = ["initial", "massage", "followUp", "missingRule", "change", "durationCorrection", "durationUnavailable", "eligibilityChanged", "revoked", "afterReview", "providerDuration", "offlineType", "lost"] as const;
    const failures: unknown[] = []; let next = 0;
    const run = async (mode: typeof cases[number]) => {
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
          } }), { lostWrite: mode === "lost", appointmentTypeMetadata: { "33": { durationMinutes: 30 }, "34": { durationMinutes: 60 }, "35": { durationMinutes: 45 }, "36": { durationMinutes: 45 } } });
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        const requested = mode === "massage" ? "Book a 45-minute initial Massage appointment." : mode === "durationCorrection" || mode === "durationUnavailable"
          ? "Book a 45-minute initial Physiotherapy appointment." : mode === "followUp" || mode === "eligibilityChanged"
          ? "Book a 30-minute follow-up Physiotherapy appointment. I am a returning patient, this is not a new problem, and my last visit was 2 months ago."
          : mode === "missingRule" ? "Book a 30-minute follow-up Physiotherapy appointment." : "Book a sixty-minute initial Physiotherapy appointment.";
        await play(requested); assert.equal(models.length, 0, "public service choice must come from exact caller attributes, not model guesses");
        if (mode === "missingRule") { assert.equal(f.mail.length, 0); assert.equal(call.writeRequests.length, 0); assert.match(call.spoken.at(-1)!, /can.t|unavailable|clinic/); return; }
        await voiceUntil(() => f.mail.length === 1, "service-specific verification"); await call.verify(f.mail[0]!.code);
        if (mode === "providerDuration") f.providerTypes.set("34", { name: "Physiotherapy initial", duration: 30 });
        if (mode === "offlineType") f.providerTypes.set("34", { name: "Physiotherapy initial", duration: 60, online: false });
        await play("Show times on October 8.");
        if (mode === "providerDuration" || mode === "offlineType") { assert.equal(call.writeRequests.length, 0); assert.equal(Object.keys((await call.state()).actions).length, 0); return; }
        await play("The first time, please.");
        let action = Object.values((await call.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation");
        if (action.mutation.request.kind !== "book") throw new Error("expected selected booking");
        assert.equal(action.mutation.request.offer.presentation?.durationMinutes, mode === "massage" || mode === "durationCorrection" || mode === "durationUnavailable" ? 45 : mode === "followUp" || mode === "eligibilityChanged" ? 30 : 60);
        assert.match(call.spoken.at(-1)!, /Demo Practitioner at Demo North/);
        if (mode === "change") {
          const old = action.key; await play("Book a 45-minute initial Massage appointment.");
          assert.equal((await call.state()).actions[old]?.status, "canceled");
          await voiceUntil(() => f.mail.length === 2, "fresh service-change verification");
          assert.equal(call.writeRequests.length, 0);
          await call.verify(f.mail[1]!.code); await play("Show times on October 8."); await play("The first time, please.");
          action = Object.values((await call.state()).actions).at(-1)!;
          assert.match(call.spoken.at(-1)!, /Massage initial.*45 minutes/);
        }
        if (mode === "durationCorrection" || mode === "durationUnavailable") {
          const old = action.key; await play(mode === "durationCorrection" ? "I want an hour appointment." : "I want an hour and a half appointment.");
          assert.equal((await call.state()).actions[old]?.status, "canceled"); assert.equal(call.writeRequests.length, 0);
          if (mode === "durationUnavailable") {
            await play("Yes"); await play("Show times on October 8.");
            assert.equal(f.mail.length, 1); assert.equal(call.writeRequests.length, 0);
            assert.equal(Object.values((await call.state()).actions).filter(value => value.status === "awaitingConfirmation").length, 0);
            return;
          }
          await voiceUntil(() => f.mail.length === 2, "duration correction verification"); await call.verify(f.mail[1]!.code);
          await play("Show times on October 8."); await play("The first time, please.");
          action = Object.values((await call.state()).actions).at(-1)!; assert.match(call.spoken.at(-1)!, /Physiotherapy initial.*60 minutes/);
        }
        if (mode === "eligibilityChanged") {
          const old = action.key; await play("Actually, this is a new problem.");
          assert.equal((await call.state()).actions[old]?.status, "canceled");
          assert.match(call.spoken.at(-1)!, /choose the service.*previous service choice cannot be used to book/);
          await play("Yes"); assert.equal(call.writeRequests.length, 0);
          await play("Book a 60-minute initial Physiotherapy appointment.");
          await voiceUntil(() => f.mail.length === 2, "changed-eligibility verification"); await call.verify(f.mail[1]!.code);
          await play("Show times on October 8."); await play("The first time, please.");
          action = Object.values((await call.state()).actions).at(-1)!;
          assert.match(call.spoken.at(-1)!, /Physiotherapy initial.*60 minutes/);
        }
        if (mode === "revoked") await f.replaceServices({ enabled: false });
        if (mode === "afterReview") f.setOnRecall(async () => f.replaceServices({ enabled: false }));
        await play("Yes");
        const blocked = mode === "revoked" || mode === "afterReview";
        assert.equal(call.writeRequests.length, blocked ? 0 : 1);
        assert.equal((await call.state()).actions[action.key]?.status, blocked ? "rejected" : mode === "lost" ? "uncertain" : "committed");
        if (!blocked) {
          const body = call.writeRequests[0]!.body;
          assert.equal(body.appointment_type_id, mode === "massage" || mode === "change" ? "35" : mode === "followUp" ? "33" : "34");
          assert.equal(body.business_id, "11"); assert.equal(body.practitioner_id, "22");
          await play("Book a 45-minute initial Massage appointment."); assert.equal(call.writeRequests.length, 1); assert.equal(f.mail.length, ["change", "eligibilityChanged", "durationCorrection"].includes(mode) ? 2 : 1);
        }
        assert.ok(models.every(text => verificationCanaries.every(secret => !text.includes(secret))));
      } finally { await call?.close(); await f.close(); }
    };
    await Promise.all(Array.from({ length: 3 }, async () => { for (;;) { const index = next++, mode = cases[index]; if (!mode) return;
      try { await run(mode); } catch (error) { failures.push(new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); } } }));
    if (failures.length) throw new AggregateError(failures, failures.map(error => String(error)).join("\n"));
    assert.deepEqual(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `service_${index}`, value }))), { ok: true, value: [] });
  });
});
