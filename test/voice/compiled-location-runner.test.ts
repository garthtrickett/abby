import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { PostgresOperationalCounters } from "../../src/storage/postgres-operational-counters.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { intakeDraft } from "../support/intake-edge.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
const fixture = { services: true, smtp: true, locations: true };
describe("E2E-355 compiled shared-number location hosts retain independent authority", { concurrency: 2 }, () => {
  for (const chosen of ["North", "South"] as const) test(`E2E-355 ${chosen} public discovery precedes scoped TLS verification and native booking`, options, async () => {
    await withClinicalRunner("book", async call => {
      const play = async (text: string) => { await call.say(text); await call.mark(); };
      assert.match(call.spoken.at(-1)!, /North.*South/);
      await play("Which locations offer Massage?");
      assert.match(call.spoken.at(-1)!, /North lists Massage.*45 minutes/);
      assert.doesNotMatch(call.spoken.at(-1)!, /South lists Massage/);
      await play("What services are available at South?");
      assert.match(call.spoken.at(-1)!, /South lists Physiotherapy.*initial.*60 minutes/);
      assert.equal(call.messages.some(m => ["providerRequest", "verificationEmail", "modelTurn", "permissionDecision"].includes(m.kind)), false);
      const counters = new PostgresOperationalCounters(call.db);
      for (const row of call.locations) assert.equal((await counters.snapshot(row.scope)).callOwnerStarted, 0);
      await play(chosen);
      const selected = call.locations.find(row => row.scope.locationId === (chosen === "North" ? "main" : "south"))!;
      assert.ok(selected);
      assert.notEqual(call.locations[0]!.policyVersion, call.locations[1]!.policyVersion);
      if (chosen === "South") assert.match(call.spoken.at(-1)!, /Welcome to the South clinic/);
      await play(chosen === "North" ? "Book a 45-minute initial Massage appointment." : "Book a 60-minute initial Physiotherapy appointment.");
      await call.verify();
      const mail = call.messages.find(m => m.kind === "verificationEmail")!;
      assert.deepEqual(mail.scope, selected.scope);
      assert.equal(mail.email, chosen === "North" ? verificationCanaries[0] : "south-registered@example.test");
      const smtp = call.messages.find(m => m.kind === "smtpDelivery");
      assert.ok(smtp?.accepted && smtp.envelopeMatches && smtp.codeMatches); assert.equal(smtp.messages, 1);
      await play("Show times on October 8."); await play("The first time, please.");
      assert.equal(call.mutations.length, 0);
      await call.say("Yes.");
      assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      const writes = call.mutations.filter(m => m.path === "/v1/individual_appointments");
      assert.equal(writes.length, 1);
      assert.equal(writes[0]!.body?.business_id, selected.businessId);
      assert.equal(writes[0]!.body?.appointment_type_id, chosen === "North" ? "35" : "34");
      for (const m of call.messages.filter(m => ["providerRequest", "verificationEmail", "permissionDecision"].includes(m.kind))) assert.deepEqual(m.scope, selected.scope);
      assert.ok(!call.messages.filter(m => m.kind === "modelTurn").some(m => /locations|services|North|South/.test(m.text!)));
      for (const row of call.locations) assert.equal((await counters.snapshot(row.scope)).callOwnerStarted, row.scope.locationId === selected.scope.locationId ? 1 : 0);
      await call.scan([...verificationCanaries.slice(0, 2), "south-registered@example.test", mail.code!]);
    }, fixture);
  });

  test("E2E-355 withdrawing the selected route after discovery prevents patient binding", options, async () => {
    await withClinicalRunner("book", async call => {
      await call.say("What services are available at South?"); await call.mark();
      await call.revokeCatalogue(call.locations.find(row => row.scope.locationId === "south")!.scope);
      await call.say("South", false, true);
      assert.equal(call.messages.some(m => ["providerRequest", "verificationEmail", "permissionDecision"].includes(m.kind)), false);
      assert.equal(call.mutations.length, 0);
      assert.equal((await call.signedWebhook()).status, 503);
    }, fixture);
  });

  test("E2E-355 withdrawing the selected route after verification prevents a native send", options, async () => {
    await withClinicalRunner("book", async call => {
      const play = async (text: string) => { await call.say(text); await call.mark(); };
      await play("South"); await play("Book a 60-minute initial Physiotherapy appointment."); await call.verify();
      await play("Show times on October 8."); await play("The first time, please.");
      await call.revokeCatalogue(call.locations.find(row => row.scope.locationId === "south")!.scope);
      await call.say("Yes.", false, true);
      assert.equal(call.mutations.length, 0);
      assert.doesNotMatch(call.spoken.at(-1)!, /Your booking is confirmed/);
    }, fixture);
  });

  test("E2E-355 selected-location permission denial cannot fall back to another host", options, async () => {
    await withClinicalRunner("book", async call => {
      await call.say("South"); await call.mark();
      call.child.send({ kind: "denyPermission" });
      await call.say("Book a 60-minute initial Physiotherapy appointment.");
      await voiceUntil(() => call.messages.some(m => m.kind === "permissionDecision" && m.allowed === false), "selected location permission decision");
      assert.equal(call.messages.some(m => m.kind === "verificationEmail"), false);
      const decisions = call.messages.filter(m => m.kind === "permissionDecision");
      assert.ok(decisions.length); assert.ok(decisions.every(m => m.allowed === false && m.scope?.locationId === "south"));
      assert.equal(call.mutations.length, 0);
    }, fixture);
  });

  test("E2E-355 first-time South caller uses its private adapter and independent registration/book confirmations", options, async () => {
    await withClinicalRunner("intake", async call => {
      const play = async (text: string) => { await call.say(text); await call.mark(); };
      await play("What services are available at South?");
      assert.equal(call.messages.some(m => ["privateFrame", "providerRequest", "verificationEmail"].includes(m.kind)), false);
      await play("South");
      await play("I'm a new patient. I'd like to book an appointment.");
      await play("Physiotherapy."); await play("Initial assessment."); await play("One hour."); await play("A female practitioner, please.");
      await call.digit("1"); await call.mark();
      await voiceUntil(() => call.spoken.at(-1)?.includes("Press one to acknowledge") === true, "selected-location consent prompt");
      await call.mark(); await call.digit("1"); await call.mark();
      const privateFields = [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test"];
      for (const field of privateFields) { await call.say(field, true); await call.mark(); }
      await voiceUntil(() => call.spoken.at(-1)?.includes("six digits on the keypad") === true, "selected-location code prompt");
      await call.mark(); await call.verify();
      const south = call.locations.find(row => row.scope.locationId === "south")!;
      for (const m of call.messages.filter(m => ["privateFrame", "privateFinal", "verificationEmail", "permissionDecision", "providerRequest"].includes(m.kind))) assert.deepEqual(m.scope, south.scope);
      const mail = call.messages.find(m => m.kind === "verificationEmail")!;
      const smtp = call.messages.find(m => m.kind === "smtpDelivery");
      assert.ok(smtp?.accepted && smtp.envelopeMatches && smtp.codeMatches); assert.equal(smtp.messages, 1);
      await play("Save my details."); assert.equal(call.mutations.length, 0);
      await play("Yes.");
      assert.equal(call.mutations.filter(m => m.path === "/v1/patients").length, 1);
      assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 0);
      await play("Show times on October 8."); await play("The first time, please.");
      assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 0);
      await call.say("Yes.");
      const writes = call.mutations.filter(m => m.path === "/v1/individual_appointments"); assert.equal(writes.length, 1);
      assert.equal(writes[0]!.body?.business_id, "12"); assert.equal(writes[0]!.body?.patient_id, "42");
      assert.equal(writes[0]!.body?.appointment_type_id, "34"); assert.equal(writes[0]!.body?.practitioner_id, "24");
      assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      const ordinary = JSON.stringify(call.messages.filter(m => ["ordinaryFinal", "modelTurn"].includes(m.kind)));
      for (const field of [...privateFields, mail.code!]) assert.equal(ordinary.includes(field), false);
      await call.scan([intakeDraft.firstName, intakeDraft.email, intakeDraft.dateOfBirth, mail.code!]);
    }, fixture);
  });
});
