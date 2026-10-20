import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { serviceBookingFixture } from "../support/service-booking-catalogue.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-350 signed generic booking routes require current played service questions before verification or native writes", { timeout: 150_000 }, async () => {
  await withDisposablePostgres(async db => {
    const cases = ["ordinary", "makeBooking", "nextWeek", "revokedDuringModel", "changedSource", "unplayed", "forgedChoice", "server", "restart", "lost"] as const;
    let next = 0; const failures: unknown[] = [];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (;;) {
        const mode = cases[next++]; if (!mode) return;
        const f = await serviceBookingFixture(); f.flow.dispose();
        let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
        const models: string[] = [];
        const request = mode === "makeBooking" ? "I'm looking to make a booking." : mode === "nextWeek" ? "I'd like an appointment next week."
          : "Can I arrange a physiotherapy appointment?";
        try {
          call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic-key", model: "synthetic-model",
            clinicDate: () => "2026-10-04", fetch: async (_input, init) => {
              const value = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText; models.push(value);
              assert.ok([request, "Show times on October 8.", "Could you help me arrange another appointment?"].includes(value));
              if (mode === "server") return new Response(null, { status: 503 });
              if (mode === "revokedDuringModel") await f.replaceServices({ enabled: false });
              const menu = value === "Show times on October 8.";
              const result = { kind: menu ? "menu" : "workflow", operation: menu ? null : "book", stage: null,
                from: menu ? "2026-10-08" : null, to: menu ? "2026-10-08" : null, choice: null,
                ...(mode === "forgedChoice" ? { serviceChoice: { name: "Physiotherapy", visitKind: "initial", durationMinutes: 60 } } : {}) };
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(result) }] }] });
            } }), { lostWrite: mode === "lost", appointmentTypeMetadata: { "34": { durationMinutes: 60 }, "35": { durationMinutes: 45 } } });
          const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
          await call.turn(request);
          assert.deepEqual(models, [request]); assert.equal(f.mail.length, 0); assert.equal(call.writeRequests.length, 0);
          if (["revokedDuringModel", "forgedChoice", "server"].includes(mode)) {
            if (mode === "revokedDuringModel") assert.match(call.spoken.at(-1)!, /can.t check the service options/);
            assert.doesNotMatch(call.spoken.at(-1)!, /Which service/); await call.mark(); await play("Yes.");
            assert.equal(f.mail.length, 0); assert.equal(call.writeRequests.length, 0); continue;
          }
          assert.match(call.spoken.at(-1)!, /Which service.*Physiotherapy.*Massage/);
          if (mode === "unplayed") {
            await call.turn("Physiotherapy.", { interrupt: true }); await call.mark(); assert.equal(f.mail.length, 0); continue;
          }
          await call.mark();
          if (mode === "changedSource") {
            await f.replaceServices({ revision: "services-2" }); await play("Physiotherapy.");
            assert.match(call.spoken.at(-1)!, /choose the service.*again/); assert.equal(f.mail.length, 0); continue;
          }
          await play("Physiotherapy."); await play("Initial assessment."); await play("One hour.");
          assert.equal(f.mail.length, 0); assert.match(call.spoken.at(-1)!, /practitioner preference/);
          await play("No preference."); assert.deepEqual(models, [request], "question answers cannot enter the classifier");
          await voiceUntil(() => f.mail.length === 1, "generic booking verification"); await call.verify(f.mail[0]!.code);
          await play("Show times on October 8."); await play("The first time, please.");
          let action = Object.values((await call.state()).actions).at(-1)!;
          if (mode === "restart") {
            const previous = action.key; await play("Could you help me arrange another appointment?");
            assert.equal((await call.state()).actions[previous]?.status, "canceled"); assert.equal(f.mail.length, 1);
            assert.match(call.spoken.at(-1)!, /Which service/);
            await play("Massage."); await play("Initial assessment."); await play("45 minutes."); await play("No preference.");
            await voiceUntil(() => f.mail.length === 2, "restarted booking fresh verification"); await call.verify(f.mail[1]!.code);
            await play("Show times on October 8."); await play("The first time, please."); action = Object.values((await call.state()).actions).at(-1)!;
          }
          assert.match(call.spoken.at(-1)!, mode === "restart" ? /Massage initial.*45 minutes/ : /Physiotherapy initial.*60 minutes/);
          await play("Yes."); assert.equal(call.writeRequests.length, 1);
          assert.equal(call.writeRequests[0]!.body.appointment_type_id, mode === "restart" ? "35" : "34");
          assert.equal((await call.state()).actions[action.key]?.status, mode === "lost" ? "uncertain" : "committed");
          await play("Could you help me arrange another appointment?");
          assert.equal(call.writeRequests.length, 1); assert.equal(f.mail.length, mode === "restart" ? 2 : 1);
        } catch (error) { failures.push(new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })); }
        finally { await call?.close(); await f.close(); }
      }
    }));
    if (failures.length) throw new AggregateError(failures, failures.map(String).join("\n"));
    assert.deepEqual(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `entry_${index}`, value }))), { ok: true, value: [] });
  });
});
