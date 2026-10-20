import assert from "node:assert/strict";
import test from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

for (const mode of ["approved", "legacy", "lateBusy"] as const)
  test(`E2E-414 compiled native recurring extra opening ${mode} preserves played consent and fresh source authority`, {
    skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000,
  }, async () => {
    await withClinicalRunner("book", async call => {
      const play = async (text: string) => { await call.say(text); await call.mark(); };
      await play("Book a 60-minute initial Physiotherapy appointment."); await call.verify();
      await play("Show times on October 8.");
      const posts = () => call.mutations.filter(row => row.path === "/v1/individual_appointments");
      const scan = () => call.scan([...verificationCanaries.slice(0, 2), "private-calendar-canary", call.messages.find(row => row.kind === "verificationEmail")!.code!]);
      if (mode === "legacy") {
        assert.doesNotMatch(call.spoken.at(-1)!, /1:00 PM|13:00|Your booking is confirmed/i);
        assert.equal(posts().length, 0); await scan(); return;
      }
      assert.match(call.spoken.at(-1)!, /1:00 PM|13:00/i);
      await play("The first time, please."); assert.equal(posts().length, 0);
      if (mode === "lateBusy") {
        call.child.send({ kind: "occupyCalendar" });
        await voiceUntil(() => call.messages.some(row => row.kind === "calendarOccupied"), "late busy interval over native recurring opening");
      }
      await call.say("Yes.");
      if (mode === "lateBusy") {
        assert.equal(posts().length, 0); assert.notEqual(call.spoken.at(-1), "Your booking is confirmed.");
      } else {
        assert.equal(posts().length, 1); assert.equal(posts()[0]!.body?.starts_at, "2026-10-08T02:00:00.000Z");
        assert.equal(posts()[0]!.body?.appointment_type_id, "34"); assert.equal(posts()[0]!.body?.business_id, "11");
        assert.equal(posts()[0]!.body?.practitioner_id, "22"); assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
        assert.ok(call.messages.filter(row => row.kind === "providerRequest" && row.path === "/v1/availability_blocks").length >= 4);
      }
      assert.equal(call.messages.some(row => row.path?.endsWith("/available_times")), false);
      await scan();
    }, { services: true, smtp: true, offlineCalendar: true, recurringOpening: mode === "legacy" ? "legacy" : "approved" });
  });
