import assert from "node:assert/strict";
import { test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { sql } from "kysely";

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

for (const scenario of ["success", "unknownFirst", "unknownSecond"] as const)
  test(`E2E-381 signed compiled correction tasks ${scenario} isolate fresh codes, private fields and native outcomes`,
    { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
      await withClinicalRunner("patientUpdate", async call => {
        const cities = ["First Private Runner Town", "Second Private Runner Town"];
        const count = scenario === "unknownFirst" ? 1 : 2;
        for (let index = 0; index < count; index++) {
          await call.say("I need to update my contact details."); await call.mark();
          await voiceUntil(() => call.messages.filter(m => m.kind === "verificationEmail").length === index + 1,
            "this correction task's fresh registered-channel code");
          assert.equal(call.mutations.filter(m => m.method === "PATCH").length, index);
          const before = call.spoken.length;
          await call.verify(); await call.mark();
          await voiceUntil(() => call.spoken.slice(before).some(s => s.includes("accept these privacy")), "new private correction terms");
          await call.mark(); await call.digit("1"); await call.mark();
          const prompts = call.spoken.length;
          await call.keypad("9#"); await voiceUntil(() => call.spoken.length > prompts, "new private city prompt"); await call.mark();
          await call.say(cities[index]!, true); await call.mark();
          await call.digit("2"); await call.mark(); await call.mark();
          await call.keypad("#"); await call.quietAfterPrivateInput();
          await call.say("Prepare the correction."); await call.mark();
          assert.equal(call.mutations.filter(m => m.method === "PATCH").length, index);
          if (scenario === "unknownFirst" || scenario === "unknownSecond" && index === 1) call.child.send({ kind: "loseWrite" });
          await call.say("Yes."); await call.mark();
          const patches = call.mutations.filter(m => m.method === "PATCH");
          assert.equal(patches.length, index + 1); assert.deepEqual(patches[index]!.body, { city: cities[index] });
        }
        const reviews = call.mutations.filter(m => m.path === "/v1/recalls");
        assert.equal(reviews.length, count); assert.equal(new Set(reviews.map(m => m.body!.notes)).size, count);
        assert.equal(call.messages.filter(m => m.kind === "verificationResult" && m.verified).length, count);
        await call.say("I need to update my contact details."); await call.mark();
        assert.equal(call.messages.filter(m => m.kind === "verificationEmail").length, count);
        assert.equal(call.mutations.filter(m => m.method === "PATCH").length, count);
        const pending = await sql<{ count: string }>`select count(*)::text as count from cliniko_contact_changes`.execute(call.db);
        assert.equal(pending.rows[0]!.count, scenario === "success" ? "0" : "2");
        const revisions = await sql<{ version: number }>`select version from cliniko_contact_revisions order by credential_fingerprint`.execute(call.db);
        // Beginning and completing each change independently invalidate prior
        // proofs; an uncertain change retains only its beginning fence.
        const completed = scenario === "success" ? 2 : scenario === "unknownFirst" ? 0 : 1;
        const expected = completed * 2 + (scenario === "success" ? 0 : 1);
        assert.deepEqual(revisions.rows.map(row => row.version), [expected, expected]);
        const secrets = [...cities, ...verificationCanaries, "correction-chart-canary", "1980-01-02", "1 Example Road",
          ...call.messages.filter(m => m.kind === "verificationEmail").map(m => m.code!)];
        for (const value of secrets) assert.equal(call.messages.some(m => m.kind === "modelTurn" && m.text?.includes(value)), false);
        await call.scan(secrets);
      }, { taskSequence: true });
    });
