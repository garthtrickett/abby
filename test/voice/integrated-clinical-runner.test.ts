import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { intakeDraft } from "../support/intake-edge.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120000 };
describe("E2E-354 compiled integration uses current service and TLS verification components", { concurrency: 2 }, () => {
  test("E2E-354 existing-patient service choice precedes actual encrypted mail and exact native booking", options, async () => {
    await withClinicalRunner("book", async call => {
      await call.say("I'd like to book an appointment."); await call.mark();
      assert.equal(call.messages.some(message => message.kind === "verificationEmail"), false);
      await call.say("Physiotherapy."); await call.mark(); await call.say("Initial assessment."); await call.mark();
      await call.say("One hour."); await call.mark(); await call.say("Anyone, please."); await call.mark();
      await call.verify();
      const smtp = call.messages.find(message => message.kind === "smtpDelivery");
      assert.ok(smtp?.accepted && smtp.envelopeMatches && smtp.codeMatches); assert.equal(smtp.messages, 1);
      await call.say("Show times on October 8."); await call.mark(); await call.say("The first time, please.");
      assert.equal(call.mutations.filter(mutation => mutation.path === "/v1/individual_appointments").length, 0);
      await call.mark(); await call.say("Yes.");
      const write = call.mutations.find(mutation => mutation.path === "/v1/individual_appointments");
      assert.ok(write); assert.equal(write.body?.appointment_type_id, "34"); assert.equal(write.body?.practitioner_id, "22");
      assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      await call.scan([...verificationCanaries.slice(0, 2), call.messages.find(message => message.kind === "verificationEmail")!.code!]);
    }, { services: true, smtp: true });
  });

  test("E2E-354 first-time initial service and gender preference retain separate registration and booking authority", options, async () => {
    await withClinicalRunner("intake", async call => {
      await call.say("I'm a new patient. I'd like to book an appointment."); await call.mark();
      await call.say("Physiotherapy."); await call.mark(); await call.say("Initial assessment."); await call.mark();
      await call.say("One hour."); await call.mark(); await call.say("A female practitioner, please."); await call.mark();
      assert.equal(call.messages.some(message => message.kind === "verificationEmail"), false);
      await call.digit("1"); await call.mark();
      await voiceUntil(() => call.spoken.at(-1)?.includes("Press one to acknowledge") === true, "compiled consent prompt");
      await call.mark(); await call.digit("1"); await call.mark();
      for (const field of [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test"]) {
        await call.say(field, true); await call.mark();
      }
      await voiceUntil(() => call.spoken.at(-1)?.includes("six digits on the keypad") === true, "compiled private code prompt");
      await call.mark(); await call.verify();
      const smtp = call.messages.find(message => message.kind === "smtpDelivery");
      assert.ok(smtp?.accepted && smtp.envelopeMatches && smtp.codeMatches); assert.equal(smtp.messages, 1);
      await call.say("Save my details."); await call.mark(); await call.say("Yes.");
      assert.equal(call.mutations.filter(mutation => mutation.path === "/v1/patients").length, 1);
      assert.equal(call.mutations.filter(mutation => mutation.path === "/v1/individual_appointments").length, 0);
      await call.mark(); await call.say("Show times on October 8."); await call.mark(); await call.say("The first time, please.");
      await call.mark(); await call.say("Yes.");
      const write = call.mutations.find(mutation => mutation.path === "/v1/individual_appointments");
      assert.ok(write); assert.equal(write.body?.patient_id, "42"); assert.equal(write.body?.appointment_type_id, "34"); assert.equal(write.body?.practitioner_id, "24");
      assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      await call.scan([intakeDraft.firstName, intakeDraft.email, intakeDraft.dateOfBirth, call.messages.find(message => message.kind === "verificationEmail")!.code!]);
    }, { services: true, smtp: true });
  });
});
