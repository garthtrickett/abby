import assert from "node:assert/strict";
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import type { ActionState } from "../../src/core/model.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { representativeChangeCallFixture } from "../support/representative-change-call.ts";
import { syntheticTaskSequence } from "../support/call-task-sequence.ts";
import { clinikoWorkflowVoiceFixture, syntheticWorkflowAccountSid, voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { captureScopedWorkflowVerificationCanaryWindow, assertSqlVerificationCodeCanary } from "../support/sql-verification-canary.ts";
import { distinctFromClock, drawSqlCanaryCode } from "../support/verification-code-canary.ts";
import { callIdFor } from "../../src/voice/admission.ts";

for (const { scenario, forcePublicCollision } of [
  { scenario: "cancel", forcePublicCollision: false },
  { scenario: "reschedule", forcePublicCollision: false },
  { scenario: "readThenCancel", forcePublicCollision: false },
  { scenario: "reschedule", forcePublicCollision: true },
] as const) {
  test(forcePublicCollision ? "E2E-389 signed related-patient reschedule rejects a preexisting public code draw while retaining every privacy check" :
    `E2E-389 signed related-patient ${scenario} privately verifies the operation and requires played clinical consent`, { timeout: 120_000 }, async context => {
    await withDisposablePostgres(async (db, connectionString, snapshot) => {
      const f = await representativeChangeCallFixture(scenario === "readThenCancel" ? "appointments.read" : scenario); f.flow.dispose();
      const source = await syntheticTaskSequence(f.flowConfig, f.f.folder); await source.replace({ patientSelection: "independentlyVerifiedPatients" });
      let call: Awaited<ReturnType<typeof clinikoWorkflowVoiceFixture>> | undefined;
      let canary: Awaited<ReturnType<typeof captureScopedWorkflowVerificationCanaryWindow>> | undefined;
      let collision: string | undefined, forced = false;
      try {
        assert.equal(f.mail.length, 0, "pre-challenge exclusions cannot contain an issued secret");
        if (forcePublicCollision) {
          const original = crypto.randomInt;
          context.mock.method(crypto, "randomInt", (...args: unknown[]) => {
            if (!forced && collision !== undefined && args.length === 2 && args[0] === 0 && args[1] === 1_000_000) {
              forced = true; return Number(collision);
            }
            return Reflect.apply(original, crypto, args);
          });
          syncBuiltinESMExports();
        }
        canary = await captureScopedWorkflowVerificationCanaryWindow(db, connectionString, snapshot);
        const eligiblePublicCodes = (text: string) => [...text.matchAll(/[0-9]{6,}/g)]
          .flatMap(match => Array.from({ length: match[0].length - 5 }, (_, offset) => match[0].slice(offset, offset + 6)))
          .filter(value => Number(value) % 10 === 0 && distinctFromClock(Number(value), canary!.window));
        let syntheticCallSid: string | undefined;
        if (forcePublicCollision) {
          for (let seed = 0; seed < 256 && !syntheticCallSid; seed++) {
            const candidate = "CA" + createHash("sha256").update("related-change-public-canary:" + seed).digest("hex").slice(0, 32);
            if (eligiblePublicCodes(callIdFor({ accountRef: syntheticWorkflowAccountSid, providerCallRef: candidate })).length)
              syntheticCallSid = candidate;
          }
          assert.ok(syntheticCallSid, "bounded public-call identity must supply an eligible pre-challenge code");
        }
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
        }, syntheticCallSid ? { syntheticCallSid } : {});
        assert.equal(f.mail.length, 0, "the second database snapshot still precedes every challenge");
        canary.excludePreexistingPublicText(await snapshot());
        const publicSnapshot = async () => JSON.stringify([call!.modelTurns, call!.transcripts,
          await call!.state(), await call!.flow.publicIntentContext()]);
        const beforeFirstChallenge = await publicSnapshot();
        if (forcePublicCollision) {
          collision = eligiblePublicCodes(beforeFirstChallenge)[0];
          assert.ok(collision && beforeFirstChallenge.includes(collision), "controlled draw must already be public");
          assert.ok(drawSqlCanaryCode(() => Number(collision), canary.window) === Number(collision),
            "clock/fraction rules alone must accept the controlled public collision");
        }
        const operations = scenario === "readThenCancel" ? ["appointments.read", "cancel"] as const : [scenario];
        let firstRead: unknown;
        for (const [index, operation] of operations.entries()) {
          const id = index === 0 ? "43" : "44", patient = f.r.patients.get(id)!;
          const request = operation === "appointments.read" ? "Check the appointment time for my husband" : operation === "cancel"
            ? index === 0 ? "Cancel an appointment for my partner" : "Cancel an appointment for my son" : "Move an appointment for my partner";
          await call.turn(request); await call.mark();
          canary.excludePreexistingPublicText(await publicSnapshot());
          await call.privateDigit("1"); await call.mark(); await f.waitForMail(index * 2 + 1);
          if (forcePublicCollision && index === 0) {
            assert.ok(forced && f.mail[0]!.code !== collision && !beforeFirstChallenge.includes(f.mail[0]!.code),
              "the actual issuer must reject the preexisting public draw before sending a code");
          }
          for (const digit of `${f.mail.at(-1)!.code}#`) call.sendEvent({ event: "dtmf", dtmf: { track: "inbound", digit } });
          await voiceUntil(() => call!.spoken.at(-1) === "Please say the patient's first name.", "private change patient field"); await call.mark();
          for (const field of [patient.first_name, patient.last_name, index === 0 ? "5 March 1982" : "28 February 2014"]) { await call.privateField(field); await call.mark(); }
          canary.excludePreexistingPublicText(await publicSnapshot());
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
        for (const [index, secret] of secrets.entries()) assert.equal(publicData.includes(secret), false,
          `related-change private canary ${index} occurred in public state`);
        assert.deepEqual(resultValue(await scanPatientDataCanaries(db, secrets.map((value, i) => ({ label: `related_change_${i}`, value })))), []);
        const backup = await snapshot();
        for (const [index, secret] of secrets.entries()) assert.equal(backup.includes(secret), false,
          `related-change private canary ${index} occurred in the full backup`);
        for (const message of f.mail) await assertSqlVerificationCodeCanary(db, message.code, canary.window);
      } finally {
        try { await call?.close(); }
        finally {
          try { await f.close(); }
          finally {
            try { canary?.close(); }
            finally { context.mock.restoreAll(); syncBuiltinESMExports(); }
          }
        }
      }
    });
  });
}
