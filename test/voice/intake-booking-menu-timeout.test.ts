import assert from "node:assert/strict";
import test from "node:test";
import { intakeServiceFixture } from "../support/intake-service-catalogue.ts";
import { intakeDraft } from "../support/intake-edge.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";

test("registered caller keeps a live session and fixed fresh-options refusal after the actual booking-menu deadline", { timeout: 60_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await intakeServiceFixture(); f.flow.dispose();
    const original = f.directory.findByRef.bind(f.directory);
    let held = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.directory.findByRef = async ref => { if (held) await gate; return original(ref); };
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic", model: "synthetic-model", clinicDate: () => "2026-10-04",
        fetch: async (_value, init) => {
          const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
          assert.ok(["Save my details.", "Show times on October 8."].includes(text));
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
            text: JSON.stringify(text === "Save my details." ? { kind: "save", operation: null, stage: null, from: null, to: null, choice: null }
              : { kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null }) }] }] });
        } }), { transitionTrace: true, beforeBookingMenuRead: () => { held = true; }, appointmentTypeMetadata: { "34": { durationMinutes: 60 } } });
      const voice = call;
      const play = async (text: string) => { await voice.turn(text); await voice.mark(); };
      await play("I'm a new patient. Book a 60-minute initial Physiotherapy appointment.");
      await voice.privateDigit("1"); await voice.mark();
      await voiceUntil(() => voice.spoken.at(-1)!.includes("Press one to acknowledge"), "recovery acknowledgment");
      await voice.mark(); await voice.privateDigit("1"); await voice.mark();
      for (const field of [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test"]) {
        await voice.privateField(field); await voice.mark();
      }
      await voiceUntil(() => f.mail.length === 1 && voice.spoken.at(-1)!.includes("six digits on the keypad"), "prospective patient verification");
      await voice.mark(); await voice.verify(f.mail[0]!.code); await play("Save my details."); await play("Yes.");
      assert.equal(f.provider.patientPosts, 1); assert.equal(voice.writeRequests.length, 0);
      await play("Show times on October 8.");
      const state = await voice.state(); assert.equal(state.lifecycle, "active");
      assert.match(voice.spoken.at(-1)!, /fresh options/); assert.equal(voice.writeRequests.length, 0); assert.equal(f.provider.patientPosts, 1);
    } finally {
      held = false; release(); await call?.close(); await f.close();
    }
  });
});
