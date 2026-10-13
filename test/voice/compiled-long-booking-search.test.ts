import assert from "node:assert/strict";
import { test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

test("E2E-356 compiled verified caller searches two months and separately confirms the exact late native time", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000,
}, async () => {
  await withClinicalRunner("book", async call => {
    const play = async (text: string) => { await call.say(text); await call.mark(); };
    await play("Book a 60-minute initial Physiotherapy appointment."); await call.verify();
    await play("Show times between October 5 and November 30.");
    assert.match(call.spoken.at(-1)!, /20 November|November 20|2026-11-20/);
    assert.ok(call.messages.filter(m => m.kind === "providerRequest" && m.path?.endsWith("/available_times")).length >= 9);
    await play("The first time, please."); assert.equal(call.mutations.length, 0);
    await call.say("Yes.");
    const writes = call.mutations.filter(m => m.path === "/v1/individual_appointments");
    assert.equal(writes.length, 1); assert.equal(writes[0]!.body?.starts_at, "2026-11-20T04:00:00.000Z");
    assert.equal(writes[0]!.body?.appointment_type_id, "34"); assert.equal(writes[0]!.body?.business_id, "11");
    assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
    await call.scan([...verificationCanaries.slice(0, 2), call.messages.find(m => m.kind === "verificationEmail")!.code!]);
  }, { services: true, smtp: true, longSearch: true });
});
