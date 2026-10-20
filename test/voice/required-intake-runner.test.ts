import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { intakeDraft } from "../support/intake-edge.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
const extra = ["1 Private Registration Road", "Private Flat", "Private Building", "Private Town", "VIC", "3999", "A U"];
const expected = { address_1: extra[0], address_2: extra[1], address_3: extra[2], city: extra[3], state: extra[4], post_code: extra[5], country_code: "AU" };
describe("clinic-required intake through the compiled signed runner", { concurrency: 2 }, () => {
  for (const mode of ["complete", "missing", "revoked", "inspectionMismatch"] as const) {
    test(`E2E-369 compiled required intake ${mode} preserves private fields and separate registration/booking confirmation`, options, async () => {
      await withClinicalRunner("intake", async call => {
        await call.say("Start"); await call.mark(); await call.digit("1"); await call.mark();
        await voiceUntil(() => call.spoken.at(-1)?.includes("Press one to acknowledge") === true, "private recovery acknowledgment");
        await call.mark(); await call.digit("1"); await call.mark();
        const field = async (text: string) => { await call.say(text, true); await call.mark(); };
        for (const text of [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test", ...extra.slice(0, 5)]) await field(text);
        assert.equal(call.mutations.length, 0); assert.equal(call.messages.filter(m => m.kind === "verificationEmail").length, 0);
        if (mode === "missing") {
          await field("remove this value"); assert.match(call.spoken.at(-1)!, /postcode or postal code/);
          assert.equal(call.mutations.length, 0); assert.equal(call.messages.filter(m => m.kind === "verificationEmail").length, 0);
          await call.keypad("*"); await call.scan(extra.slice(0, 4)); return;
        }
        await field(extra[5]!); await field(extra[6]!);
        await voiceUntil(() => call.messages.some(m => m.kind === "verificationEmail"), "prospective email after all fields/readback");
        await voiceUntil(() => call.spoken.at(-1)?.includes("six digits on the keypad") === true, "private code prompt"); await call.mark();
        await call.verify(); assert.equal(call.mutations.length, 0);
        for (const value of extra.slice(0, 4)) assert.ok(call.spoken.some(text => text.includes(value)));
        if (mode === "revoked") call.child.send({ kind: "denyPermission" });
        if (mode === "inspectionMismatch") call.child.send({ kind: "mismatchIntakeField" });
        await call.say("Save"); await call.mark();
        if (mode !== "revoked") { await call.say("Yes"); await call.mark(); }
        const patients = call.mutations.filter(m => m.path === "/v1/patients");
        assert.equal(patients.length, mode === "revoked" ? 0 : 1);
        if (patients.length) for (const [key, value] of Object.entries(expected)) assert.equal(patients[0]!.body![key], value);
        assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 0);
        if (mode === "complete") {
          await call.say("Times"); await call.mark(); await call.say("Second"); await call.mark(); await call.say("Yes"); await call.mark();
          assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 1);
          assert.equal(call.mutations.find(m => m.path === "/v1/individual_appointments")!.body!.patient_id, "42");
        } else if (mode === "inspectionMismatch") {
          assert.equal(call.spoken.some(text => text === "Your details were saved. No appointment is confirmed yet."), false);
          await call.say("Times"); await call.mark();
          assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 0);
        }
        for (const value of extra.slice(0, 4)) assert.equal(call.messages.filter(m => m.kind === "modelTurn" || m.kind === "ordinaryFinal").some(m => m.text?.includes(value)), false);
        await call.scan([...extra.slice(0, 4), intakeDraft.firstName, intakeDraft.email, intakeDraft.dateOfBirth]);
      }, { intakeFields: true });
    });
  }
});
