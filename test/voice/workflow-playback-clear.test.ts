import assert from "node:assert/strict";
import test from "node:test";
import { intakeServiceFixture } from "../support/intake-service-catalogue.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";

test("signed workflow caller returns clear receipts even without an explicit interruption hint", { timeout: 60_000 }, async () => {
  await withDisposablePostgres(async db => {
    const fixture = await intakeServiceFixture(); fixture.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    try {
      call = await clinikoWorkflowVoiceFixture(db, fixture.flowConfig, owner => createOpenAIClinicalIntentResolver({
        owner, apiKey: "synthetic", model: "synthetic-model", clinicDate: () => "2026-10-04",
        fetch: async () => { throw new Error("unplayed service choice must not reach model routing"); },
      }));
      await call.turn("I'm a new patient. I'd like to book an appointment.");
      const before = call.spoken.length;
      await call.turn("Physiotherapy.");
      await voiceUntil(() => call!.spoken.length > before, "fresh speech after clearing the unplayed service guide");
      await call.mark();
      assert.ok(call.sent.some(event => event.event === "clear"));
      assert.equal(fixture.mail.length, 0);
      assert.equal(fixture.provider.patientPosts, 0);
      assert.equal(call.writeRequests.length, 0);
      assert.equal(call.flow.workflow, undefined);
    } finally { await call?.close(); await fixture.close(); }
  });
});
