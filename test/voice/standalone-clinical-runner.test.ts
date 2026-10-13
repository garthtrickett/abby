import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { intakeDraft } from "../support/intake-edge.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
const clinicalWrites = (call: Parameters<Parameters<typeof withClinicalRunner>[1]>[0]) => call.mutations.filter(m => m.path?.startsWith("/v1/individual_appointments"));

describe("actual compiled clinical runner", { concurrency: 2 }, () => {
  for (const operation of ["book", "cancel", "reschedule", "appointments.read"] as const) {
    test(`E2E-299 E2E-314 compiled runner ${operation} owns signed admission, private verification and exact outcome`, options, async () => {
      await withClinicalRunner(operation, async call => {
        await call.say("Start"); assert.match(call.spoken.at(-1)!, /six-digit code|keypad/i); await call.mark(); await call.verify();
        assert.equal(clinicalWrites(call).length, 0);
        if (operation === "book") { await call.say("Times"); await call.mark(); await call.say("Second"); }
        if (operation === "cancel") { await call.say("Appointments"); await call.mark(); await call.say("Cancel selected"); }
        if (operation === "reschedule") {
          await call.say("Source"); await call.mark(); await call.say("Select source"); await call.mark();
          await call.say("Destination"); await call.mark(); await call.say("Select destination");
        }
        if (operation === "appointments.read") {
          await call.say("Appointments"); assert.match(call.spoken.at(-1)!, /October|appointment|option/i);
          assert.equal(call.mutations.length, 0, "enquiry never creates an appointment or staff request");
        } else {
          assert.match(call.spoken.at(-1)!, /Physiotherapy|cancel|move|reschedul/i);
          assert.equal(clinicalWrites(call).length, 0, "selecting an offer does not write before confirmation playback");
          await call.mark(); await call.say("Yes");
          assert.equal(clinicalWrites(call).length, 1);
          assert.equal(call.spoken.at(-1), operation === "book" ? "Your booking is confirmed." : operation === "cancel" ?
            "Your appointment cancellation is confirmed." : "Your appointment move is confirmed.");
          const write = clinicalWrites(call)[0]!;
          assert.equal(write.method, operation === "book" ? "POST" : "PATCH");
          assert.equal(write.path?.endsWith("/cancel"), operation === "cancel");
          if (operation === "reschedule") assert.equal(write.body?.starts_at, "2026-10-08T06:00:00.000Z");
        }
        const code = call.messages.find(m => m.kind === "verificationEmail")!.code!;
        for (const privateValue of [code, ...verificationCanaries.slice(0, 2)]) {
          assert.equal(JSON.stringify(call.messages.filter(m => m.kind === "ordinaryFinal" || m.kind === "modelTurn")).includes(privateValue), false);
          assert.equal(JSON.stringify(call.spoken).includes(privateValue), false);
        }
        await call.scan([code, ...verificationCanaries.slice(0, 2)]);
        await call.revokeCatalogue(); assert.equal((await call.signedWebhook()).status, 503, "revocation denies another webhook before owner construction");
      });
    });
  }

  test("E2E-300 compiled runner privately registers first-time caller and independently confirms one subsequent booking", options, async () => {
    await withClinicalRunner("intake", async call => {
      await call.say("Start"); await call.mark(); await call.digit("1");
      assert.match(call.spoken.at(-1)!, /kept in Cliniko.*saved without an appointment or a staff request/);
      await call.mark(); await voiceUntil(() => call.spoken.at(-1)?.includes("Press one to acknowledge") === true, "separate recovery prompt");
      await call.mark(); await call.digit("1"); assert.equal(call.spoken.at(-1), "Please say your first name."); await call.mark();
      for (const text of [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test"]) {
        await call.say(text, true); await call.mark();
      }
      await voiceUntil(() => call.messages.some(m => m.kind === "verificationEmail"), "prospective verification email");
      await voiceUntil(() => call.spoken.at(-1)?.includes("six digits on the keypad") === true, "prospective code prompt"); await call.mark();
      await call.verify(); assert.equal(call.mutations.length, 0);
      await call.say("Save"); await call.mark(); await call.say("Yes");
      assert.equal(call.mutations.filter(m => m.path === "/v1/patients").length, 1); assert.equal(clinicalWrites(call).length, 0);
      const patient = call.mutations.find(m => m.path === "/v1/patients")!.body!;
      assert.deepEqual([patient.first_name, patient.last_name, patient.date_of_birth, patient.email], [intakeDraft.firstName, intakeDraft.lastName, intakeDraft.dateOfBirth, intakeDraft.email]);
      await call.mark(); await call.say("Times"); await call.mark(); await call.say("Second"); await call.mark(); await call.say("Yes");
      assert.equal(clinicalWrites(call).length, 1); assert.equal(clinicalWrites(call)[0]!.body?.patient_id, "42"); assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      const code = call.messages.find(m => m.kind === "verificationEmail")!.code!;
      const canaries = [intakeDraft.firstName, intakeDraft.email, intakeDraft.dateOfBirth, code];
      const ordinary = JSON.stringify(call.messages.filter(m => m.kind === "ordinaryFinal" || m.kind === "modelTurn"));
      for (const value of canaries) assert.equal(ordinary.includes(value), false);
      await call.scan(canaries);
    });
  });

  test("E2E-299 compiled runner uncertain booking never claims completion or repeats a possible POST", options, async () => {
    await withClinicalRunner("book", async call => {
      call.child.send({ kind: "loseWrite" }); await call.say("Start"); await call.mark(); await call.verify();
      await call.say("Times"); await call.mark(); await call.say("Second"); await call.mark(); await call.say("Yes");
      assert.equal(clinicalWrites(call).length, 1); assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
      await call.mark(); await call.say("Yes", false, true); assert.equal(clinicalWrites(call).length, 1);
    });
  });

  test("E2E-299 compiled runner cannot derive caller permission from an allowlisted phone", options, async () => {
    await withClinicalRunner("book", async call => {
      call.child.send({ kind: "denyPermission" }); await call.say("Start"); await call.mark();
      await voiceUntil(() => call.messages.some(m => m.kind === "permissionDecision" && m.allowed === false), "independent caller permission denial");
      assert.equal(call.mutations.length, 0); assert.equal(call.messages.filter(m => m.kind === "verificationEmail").length, 0);
      assert.equal(call.spoken.some(text => text.includes("is confirmed")), false);
    });
  });

  test("E2E-299 compiled runner rechecks current policy before an appointment write", options, async () => {
    await withClinicalRunner("book", async call => {
      await call.say("Start"); await call.mark(); await call.verify();
      await call.say("Times"); await call.mark(); await call.say("Second"); await call.mark();
      call.child.send({ kind: "changePolicy" }); await call.say("Yes", false, true);
      assert.equal(clinicalWrites(call).length, 0);
      assert.equal(call.spoken.some(text => text === "Your booking is confirmed."), false);
      assert.equal((await call.signedWebhook()).status, 503, "catalogue and clinical owner use the same current policy");
    });
  });

  test("E2E-299 compiled runner cannot verify a caller after delivery failed", options, async () => {
    await withClinicalRunner("book", async call => {
      call.child.send({ kind: "loseMail" }); await call.say("Start"); await call.mark(); await call.verify(false);
      assert.equal(call.messages.find(m => m.kind === "verificationEmail")?.accepted, false);
      assert.equal(call.mutations.length, 0);
      const code = call.messages.find(m => m.kind === "verificationEmail")!.code!;
      assert.equal(JSON.stringify(call.messages.filter(m => m.kind === "ordinaryFinal" || m.kind === "modelTurn")).includes(code), false);
      await call.scan([code]);
    });
  });
});
