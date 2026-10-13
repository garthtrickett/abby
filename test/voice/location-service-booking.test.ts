import assert from "node:assert/strict";
import test from "node:test";
import { locationServiceFixture } from "../support/location-service-catalogue.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-352 shared-number service discovery keeps patient proof and native writes in the chosen location", { timeout: 90000 }, async () => {
  await withDisposablePostgres(async db => {
    for (const chosen of ["North", "South"] as const) {
      const f = await locationServiceFixture(), selected = chosen === "North" ? f.north : f.south;
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        call = await clinikoWorkflowVoiceFixture(db, chosen === "North" ? selected.flowConfig : f.southConfig,
          owner => createOpenAIClinicalIntentResolver({ owner, apiKey: "synthetic", model: "synthetic-model", clinicDate: () => "2026-10-04",
            fetch: async (_value, init) => {
              const text = JSON.parse(JSON.parse(String(init?.body)).input[1].content).callerText;
              assert.equal(text, "Show times on October 8.");
              return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text",
                text: JSON.stringify({ kind: "menu", operation: null, stage: null, from: "2026-10-08", to: "2026-10-08", choice: null }) }] }] });
            } }), { routingHost: f.routingHost, locationServiceSources: f.sources, appointmentTypeMetadata: { "34": { durationMinutes: 60 }, "35": { durationMinutes: 45 } } });
        const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
        assert.equal(call.workflowStarted, false);
        await play("Which locations offer Massage?");
        assert.match(call.spoken.at(-1)!, /North lists Massage.*45 minutes/);
        assert.doesNotMatch(call.spoken.at(-1)!, /South lists Massage/);
        assert.equal(call.workflowStarted, false); assert.equal(f.north.mail.length + f.south.mail.length, 0);
        assert.equal(f.north.allTraffic.length + f.south.allTraffic.length, 0, "public discovery never reads patient/provider records");
        await play("What services are available at South?"); assert.match(call.spoken.at(-1)!, /South lists Physiotherapy.*initial.*60 minutes/);
        assert.equal(call.workflowStarted, false);
        await play(chosen); assert.equal(call.workflowStarted, true); assert.deepEqual((await call.state()).policy.scope, selected.scope);
        await play(chosen === "North" ? "Book a 45-minute initial Massage appointment." : "Book a 60-minute initial Physiotherapy appointment.");
        await voiceUntil(() => selected.mail.length === 1, "location-specific verification"); await call.verify(selected.mail[0]!.code);
        await play("Show times on October 8."); await play("The first time, please."); await play("Yes.");
        assert.equal(call.writeRequests.length, 1);
        assert.equal(call.writeRequests[0]!.body.business_id, chosen === "North" ? "11" : "12");
        assert.equal(call.writeRequests[0]!.body.appointment_type_id, chosen === "North" ? "35" : "34");
        const other = chosen === "North" ? f.south : f.north;
        assert.equal(other.mail.length, 0); assert.equal(other.allTraffic.length, 0);
        assert.ok(!call.modelTurns.some(text => /locations|services|North|South/.test(text)));
      } finally { await call?.close(); await f.close(); }
    }
    assert.deepEqual(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `location_${index}`, value }))), { ok: true, value: [] });
  });
});
