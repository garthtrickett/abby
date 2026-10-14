import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import type { ActionState } from "../../src/core/model.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { representativeChangeCallFixture } from "../support/representative-change-call.ts";
import { syntheticTaskSequence } from "../support/call-task-sequence.ts";
import { clinikoWorkflowVoiceFixture, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

for (const scenario of ["cancel", "reschedule", "readThenCancel"] as const) {
  test(`E2E-389 signed related-patient ${scenario} privately verifies the operation and requires played clinical consent`, { timeout: 120_000 }, async () => {
    await withDisposablePostgres(async db => {
      const f = await representativeChangeCallFixture(scenario === "readThenCancel" ? "appointments.read" : scenario); f.flow.dispose();
      const source = await syntheticTaskSequence(f.flowConfig, f.f.folder); await source.replace({ patientSelection: "independentlyVerifiedPatients" });
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      try {
        call = await clinikoWorkflowVoiceFixture(db, scenario === "readThenCancel" ? source.config : f.flowConfig, flow => {
          const ordinary = createOpenAIClinicalIntentResolver({ apiKey: "synthetic", model: "synthetic", owner: flow, clinicDate: () => "2026-10-04",
            fetch: async () => { throw new Error("private patient data cannot reach a model"); } });
          return async (turn, signal) => {
            if (turn.text === "Yes") return ok({ kind: "affirm" });
            if (turn.text === "Check appointments") return ok({ kind: "appointmentEnquiry", from: verificationNow, to: "2026-10-09T06:00:00.000Z" });
            if (turn.text === "Cancellation appointments" || turn.text === "Cancel it") {
              const grant = await flow.cancellationProof(); assert.ok(grant);
              return turn.text === "Cancellation appointments" ? ok({ kind: "appointments", verificationRef: grant.verificationRef, from: verificationNow, to: "2026-10-09T06:00:00.000Z" })
                : ok({ kind: "cancel", verificationRef: grant.verificationRef, targetRef: "selected" });
            }
            if (turn.text === "Move targets" || turn.text === "Move offers") return ok({ kind: "reschedulingMenu", stage: turn.text === "Move targets" ? "targets" : "offers",
              from: turn.text === "Move targets" ? verificationNow : "2026-10-08", to: turn.text === "Move targets" ? "2026-10-09T06:00:00.000Z" : "2026-10-08" });
            if (turn.text === "Select target" || turn.text === "Select offer") return ok({ kind: "reschedulingChoice", stage: turn.text === "Select target" ? "targets" : "offers", choice: 1 });
            return ordinary(turn, signal);
          };
        });
        const operations = scenario === "readThenCancel" ? ["appointments.read", "cancel"] as const : [scenario];
        let firstRead: unknown;
        for (const [index, operation] of operations.entries()) {
          const id = index === 0 ? "43" : "44", patient = f.r.patients.get(id)!;
          const request = operation === "appointments.read" ? "Check the appointment time for my husband" : operation === "cancel"
            ? index === 0 ? "Cancel an appointment for my partner" : "Cancel an appointment for my son" : "Move an appointment for my partner";
          await call.turn(request); await call.mark(); await call.privateDigit("1"); await call.mark(); await f.waitForMail(index * 2 + 1);
          for (const digit of `${f.mail.at(-1)!.code}#`) call.sendEvent({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
          await voiceUntil(() => call!.spoken.at(-1) === "Please say the patient's first name.", "private change patient field"); await call.mark();
          for (const field of [patient.first_name, patient.last_name, index === 0 ? "5 March 1982" : "28 February 2014"]) { await call.privateField(field); await call.mark(); }
          await call.privateDigit("1"); await call.mark(); await f.waitForMail(index * 2 + 2); assert.equal(f.mail.at(-1)!.email, patient.email);
          await call.verify(f.mail.at(-1)!.code);
          if (operation === "appointments.read") {
            await call.turn("Check appointments"); assert.equal((await call.state()).appointmentReads.at(-1)!.status, "shown"); await call.mark();
            firstRead = structuredClone((await call.state()).appointmentReads[0]); continue;
          }
          if (operation === "cancel") { await call.turn("Cancellation appointments"); await call.mark(); await call.turn("Cancel it"); }
          else { await call.turn("Move targets"); await call.mark(); await call.turn("Select target"); await call.mark();
            await call.turn("Move offers"); await call.mark(); await call.turn("Select offer"); }
          const action: ActionState = Object.values((await call.state()).actions).at(-1)!; assert.equal(action.status, "awaitingConfirmation"); assert.equal(call.writes.length, 0);
          await call.mark(); await call.turn("Yes"); assert.equal(call.writes.length, 1);
          assert.equal((await call.state()).actions[action.key]!.status, "committed");
          assert.equal(call.spoken.at(-1), operation === "cancel" ? "Your appointment cancellation is confirmed." : "Your appointment move is confirmed."); await call.mark();
          assert.equal(call.writeRequests[0]!.path, operation === "cancel" ? `/v1/individual_appointments/${id === "43" ? "91" : "92"}/cancel` : "/v1/individual_appointments/91");
        }
        if (firstRead) assert.deepEqual((await call.state()).appointmentReads[0], firstRead);
        assert.equal(f.mail.length, scenario === "readThenCancel" ? 4 : 2); assert.equal(call.writeRequests.length, 1);
        const secrets = [...f.r.patients.values()].flatMap(row => [row.first_name, row.last_name, row.date_of_birth, row.email]).concat(f.mail.map(row => row.code));
        const publicData = JSON.stringify([call.modelTurns, call.transcripts, await call.state(), await call.flow.publicIntentContext()]);
        for (const secret of secrets) assert.equal(publicData.includes(secret), false);
        assert.deepEqual(resultValue(await scanPatientDataCanaries(db, secrets.map((value, i) => ({ label: `related_change_${i}`, value })))), []);
      } finally { await call?.close(); await f.close(); }
    });
  });
}
