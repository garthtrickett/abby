import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { reschedulingCallFlowFixture } from "../support/cliniko-call-flow.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

for (const sameTime of [false, true]) test(`E2E-360 signed caller chooses another practitioner with ${sameTime ? "unchanged" : "changed"} time after an empty original search`, { timeout: 90_000 }, async () => {
  await withDisposablePostgres(async db => {
    const f = await reschedulingCallFlowFixture({ practitionerChoices: ["23"], sameTime,
      practitionerMoves: [{ fromPractitionerId: "22", toPractitionerId: "23", appointmentTypeId: "33", durationMinutes: 30 }] });
    f.flow.dispose();
    let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
    const seen: string[] = [];
    try {
      f.setPractitionerStarts("22", []);
      call = await clinikoWorkflowVoiceFixture(db, f.flowConfig, owner => createOpenAIClinicalIntentResolver({ owner,
        apiKey: "synthetic-key", model: "synthetic-model", clinicDate: () => "2026-10-04", fetch: async (_value, init) => {
          const body = JSON.parse(String(init?.body)), text = JSON.parse(body.input[1].content).callerText;
          assert.equal(body.store, false); seen.push(text);
          const decisions = {
            "I need to move an appointment.": { kind: "workflow", operation: "reschedule", stage: null, from: null, to: null, choice: null },
            "Show my existing appointments from October 4 through October 9.": { kind: "menu", operation: null, stage: "targets", from: "2026-10-04", to: "2026-10-09", choice: null },
            "Show move times on October 8.": { kind: "menu", operation: null, stage: "offers", from: "2026-10-08", to: "2026-10-08", choice: null },
          };
          const decision = decisions[text as keyof typeof decisions]; assert.ok(decision, `unexpected model turn: ${text}`);
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed", content: [{ type: "output_text", text: JSON.stringify(decision) }] }] });
        } }));
      const play = async (text: string) => { await call!.turn(text); await call!.mark(); };
      await play("I need to move an appointment."); await voiceUntil(() => f.mail.length === 1, "directory verification"); await call.verify(f.mail[0]!.code);
      await play("Show my existing appointments from October 4 through October 9."); await play("The first appointment.");
      await play("Show move times on October 8."); assert.match(call.spoken.at(-1)!, /check other approved practitioners/);
      await play("Yes please."); assert.match(call.spoken.at(-1)!, /Option two, Demo Destination/);
      await play("With Demo Destination please."); assert.match(call.spoken.at(-1)!, /chosen Demo Destination/);
      assert.equal(call.writeRequests.length, 0); await play("Show move times on October 8.");
      await call.turn("Option one."); assert.match(call.spoken.at(-1)!, /Demo Destination/);
      if (sameTime) assert.match(call.spoken.at(-1)!, /changing the practitioner/);
      assert.equal(call.writeRequests.length, 0); await call.mark(); await call.turn("Yes.");
      const moves = call.writeRequests.filter(write => write.method === "PATCH"); assert.equal(moves.length, 1);
      assert.equal(moves[0]!.path, "/v1/individual_appointments/91");
      assert.deepEqual(moves[0]!.body, { starts_at: sameTime ? "2026-10-08T04:00:00.000Z" : "2026-10-08T05:00:00.000Z", ends_at: null, practitioner_id: "23" });
      assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.");
      assert.equal(seen.includes("With Demo Destination please."), false, "the model must not assign a practitioner ordinal");
      assert.deepEqual(resultValue(await scanPatientDataCanaries(db, [...verificationCanaries, f.mail[0]!.code].map((value, i) => ({ label: `directory_${i}`, value })))), []);
    } finally { try { await call?.close(); } finally { await f.close(); } }
  });
});
