import assert from "node:assert/strict";
import { test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";

for (const scenario of ["success", "unknownSecond"] as const) test(`E2E-381 signed compiled two-task ${scenario} keeps each verification, confirmation and outcome independent`,
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
    await withClinicalRunner("book", async call => {
      await call.say("Book an appointment."); await call.mark(); await call.verify();
      await call.say("Show times on October 8."); await call.mark(); await call.say("The first time, please."); await call.mark();
      assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 0);
      await call.say("Yes."); await call.mark();
      assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 1);
      assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      await call.say("Book another appointment."); await call.mark();
      await voiceUntil(() => call.messages.filter(m => m.kind === "verificationEmail").length === 2, "second task's new verification mail");
      assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 1);
      await call.verify(); assert.equal(call.messages.filter(m => m.kind === "verificationResult" && m.verified).length, 2);
      await call.say("What happened?"); await call.mark(); assert.match(call.spoken.at(-1)!, /this new task/);
      await call.say("Show times on October 8."); await call.mark(); await call.say("The first time, please."); await call.mark();
      assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 1);
      if (scenario === "unknownSecond") call.child.send({ kind: "loseWrite" });
      await call.say("Yes."); await call.mark();
      const bookings = call.mutations.filter(m => m.path === "/v1/individual_appointments"); assert.equal(bookings.length, 2);
      assert.notEqual(bookings[0]!.body!.starts_at, bookings[1]!.body!.starts_at);
      assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, 2);
      if (scenario === "success") assert.equal(call.spoken.at(-1), "Your booking is confirmed.");
      else assert.match(call.spoken.at(-1)!, /can't confirm.*pending review/i);
      await call.say("Book another appointment."); await call.mark();
      assert.equal(call.mutations.filter(m => m.path === "/v1/individual_appointments").length, 2);
      assert.equal(call.messages.filter(m => m.kind === "verificationEmail").length, 2);
      const secrets = [...verificationCanaries, ...call.messages.filter(m => m.kind === "verificationEmail").map(m => m.code!)];
      for (const secret of secrets) assert.equal(call.messages.some(m => m.kind === "modelTurn" && m.text?.includes(secret)), false);
      await call.scan(secrets);
    }, { taskSequence: true });
  });
