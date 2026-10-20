import assert from "node:assert/strict";
import { test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

test("E2E-357 compiled caller books an approved offline hour after cross-business calendar conflicts", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000,
}, async () => {
  await withClinicalRunner("book", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("Book a 60-minute initial Physiotherapy appointment."); await call.verify();
    await play("Show times on October 8.");
    assert.match(call.spoken.at(-1)!, /1:00|13:00/);
    for (const family of ["daily_availabilities", "availability_blocks", "individual_appointments", "group_appointments", "unavailable_blocks"]) {
      assert.ok(call.messages.filter(m => m.kind === "providerRequest" && m.path === `/v1/${family}`).length >= 2);
    }
    assert.equal(call.messages.some(m => m.path?.endsWith("/available_times")), false);
    await play("The first time, please."); assert.equal(call.mutations.length, 0);
    await call.say("Yes.");
    const writes = call.mutations.filter(m => m.path === "/v1/individual_appointments");
    assert.equal(writes.length, 1); assert.equal(writes[0]!.body?.starts_at, "2026-10-08T02:00:00.000Z");
    assert.equal(writes[0]!.body?.appointment_type_id, "34"); assert.equal(writes[0]!.body?.business_id, "11");
    assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
    await call.scan([...verificationCanaries.slice(0, 2), "private-calendar-canary", call.messages.find(m => m.kind === "verificationEmail")!.code!]);
  }, { services: true, smtp: true, offlineCalendar: true });
});

test("E2E-357 compiled offline calendar failure cannot publish a partial menu or send a booking", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000,
}, async () => {
  await withClinicalRunner("book", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("Book a 60-minute initial Physiotherapy appointment."); await call.verify();
    await play("Show times on October 8.");
    assert.ok(call.messages.some(m => m.path === "/v1/group_appointments"));
    assert.doesNotMatch(call.spoken.at(-1)!, /1:00|13:00|Your booking is confirmed/);
    assert.equal(call.mutations.length, 0);
  }, { services: true, smtp: true, offlineCalendar: true, missingBusy: true });
});

test("E2E-357 compiled offline chosen time occupied after proposal is rechecked before sending", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000,
}, async () => {
  await withClinicalRunner("book", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("Book a 60-minute initial Physiotherapy appointment."); await call.verify();
    await play("Show times on October 8."); await play("The first time, please.");
    call.child.send({ kind: "occupyCalendar" });
    await voiceUntil(() => call.messages.some(m => m.kind === "calendarOccupied"), "calendar occupied before confirmation");
    await call.say("Yes.");
    assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 0);
    assert.notEqual(call.spoken.at(-1), "Your booking is confirmed.");
  }, { services: true, smtp: true, offlineCalendar: true });
});
