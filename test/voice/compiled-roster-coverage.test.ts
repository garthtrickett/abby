import assert from "node:assert/strict";
import { test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { intakeDraft } from "../support/intake-edge.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
for (const location of ["North", "South"] as const) test(`E2E-358 compiled ${location} offline service retains exact location/type and separate caller authority`, options, async () => {
  await withClinicalRunner("book", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("What services are available at South?");
    assert.equal(call.messages.some(m => ["providerRequest", "verificationEmail", "permissionDecision", "privateFrame"].includes(m.kind)), false);
    await play(location);
    await play(location === "North" ? "Book a 45-minute initial Massage appointment." : "Book a 60-minute initial Physiotherapy appointment.");
    await call.verify(); await play("Show times on October 8."); await play("The first time, please.");
    assert.equal(call.mutations.length, 0); await call.say("Yes.");
    const writes = call.mutations.filter(m => m.path === "/v1/individual_appointments"); assert.equal(writes.length, 1);
    assert.equal(writes[0]!.body?.business_id, location === "North" ? "11" : "12");
    assert.equal(writes[0]!.body?.appointment_type_id, location === "North" ? "35" : "34");
    assert.equal(writes[0]!.body?.starts_at, "2026-10-08T02:00:00.000Z");
    assert.equal(call.messages.some(m => m.path?.endsWith("/available_times")), false);
    assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
    const mail = call.messages.find(m => m.kind === "verificationEmail")!;
    assert.equal(mail.email, location === "North" ? verificationCanaries[0] : "south-registered@example.test");
    const selected = call.locations.find(row => row.scope.locationId === (location === "North" ? "main" : "south"))!;
    for (const message of call.messages.filter(m => ["providerRequest", "verificationEmail", "permissionDecision"].includes(m.kind))) assert.deepEqual(message.scope, selected.scope);
    await call.scan([...verificationCanaries.slice(0, 2), "private-calendar-canary", mail.code!]);
  }, { services: true, smtp: true, locations: true, offlineCalendar: true });
});

test("E2E-358 compiled two-month offline search reads more than one thousand busy records before one late booking", options, async () => {
  await withClinicalRunner("book", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("Book a 60-minute initial Physiotherapy appointment."); await call.verify();
    await play("Show times between October 5 and November 30.");
    assert.match(call.spoken.at(-1)!, /20 November|November 20|2026-11-20/);
    assert.ok(call.messages.filter(m => m.kind === "providerRequest" && m.path === "/v1/group_appointments").length > 20);
    await play("The first time, please."); assert.equal(call.mutations.length, 0); await call.say("Yes.");
    const writes = call.mutations.filter(m => m.path === "/v1/individual_appointments"); assert.equal(writes.length, 1);
    assert.equal(writes[0]!.body?.starts_at, "2026-11-20T04:00:00.000Z"); assert.equal(writes[0]!.body?.appointment_type_id, "34");
    assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
    assert.equal(call.messages.some(m => m.path?.endsWith("/available_times")), false);
    await call.scan([...verificationCanaries.slice(0, 2), "private-calendar-canary", call.messages.find(m => m.kind === "verificationEmail")!.code!]);
  }, { services: true, smtp: true, offlineCalendar: true, longSearch: true });
});

test("E2E-358 first-time South caller separately confirms registration and an offline approved female member booking", options, async () => {
  await withClinicalRunner("intake", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("South"); await play("I'm a new patient. I'd like to book an appointment.");
    await play("Physiotherapy."); await play("Initial assessment."); await play("One hour."); await play("A female practitioner, please.");
    await call.digit("1"); await call.mark();
    await voiceUntil(() => call.spoken.at(-1)?.includes("Press one to acknowledge") === true, "private consent prompt");
    await call.mark(); await call.digit("1"); await call.mark();
    const fields = [intakeDraft.firstName, intakeDraft.lastName, "21 June 1987", "private-intake-canary at example dot test"];
    for (const field of fields) { await call.say(field, true); await call.mark(); }
    await voiceUntil(() => call.spoken.at(-1)?.includes("six digits on the keypad") === true, "private code prompt");
    await call.mark(); await call.verify();
    await play("Save my details."); assert.equal(call.mutations.length, 0); await play("Yes.");
    assert.equal(call.mutations.filter(m => m.path === "/v1/patients").length, 1);
    await play("Show times on October 8."); await play("The first time, please.");
    assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 0); await call.say("Yes.");
    const writes = call.mutations.filter(m => m.path === "/v1/individual_appointments"); assert.equal(writes.length, 1);
    assert.equal(writes[0]!.body?.business_id, "12"); assert.equal(writes[0]!.body?.patient_id, "42");
    assert.equal(writes[0]!.body?.appointment_type_id, "34"); assert.equal(writes[0]!.body?.practitioner_id, "24");
    assert.equal(writes[0]!.body?.starts_at, "2026-10-08T01:00:00.000Z"); assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
    assert.equal(call.messages.some(m => m.path?.endsWith("/available_times")), false);
    const code = call.messages.find(m => m.kind === "verificationEmail")!.code!;
    const ordinary = JSON.stringify(call.messages.filter(m => ["ordinaryFinal", "modelTurn"].includes(m.kind)));
    for (const field of [...fields, code]) assert.equal(ordinary.includes(field), false);
    await call.scan([intakeDraft.firstName, intakeDraft.email, intakeDraft.dateOfBirth, code, "private-calendar-canary"]);
  }, { services: true, smtp: true, locations: true, offlineCalendar: true });
});
