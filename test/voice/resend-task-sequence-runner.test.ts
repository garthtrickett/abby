import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

for (const scenario of ["success", "unknownFirst", "unknownSecond", "permission"] as const)
  test(`E2E-381 signed compiled resend tasks ${scenario} keep private selection, consent and each mail outcome independent`,
    { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
      await withClinicalRunner("confirmationResend", async call => {
        const taskCount = scenario === "unknownFirst" ? 1 : 2;
        for (let index = 0; index < taskCount; index++) {
          await call.say(index === 0 ? "Please resend my appointment confirmation email." : "Please send the confirmation email for another appointment.");
          await call.mark();
          await voiceUntil(() => call.messages.filter(m => m.kind === "verificationEmail").length === index + 1, "this resend task's fresh registered-channel code");
          const reviewsBefore = call.mutations.filter(m => m.path === "/v1/recalls").length;
          assert.equal(reviewsBefore, index);
          if (scenario === "permission" && index === 1) {
            call.child.send({ kind: "denyPermission" }); await call.verify(false);
            assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, 1); break;
          }
          const beforeMenu = call.spoken.length; await call.verify();
          await voiceUntil(() => call.spoken.slice(beforeMenu).some(text => text.includes("Choose the appointment")), "current private resend menu");
          await call.mark();
          const ordinary = call.messages.filter(m => m.kind === "ordinaryFrame").length;
          await call.digit(String(index + 1)); await call.mark();
          await voiceUntil(() => call.spoken.at(-1)?.includes("Press pound to return") === true, "current private recipient readback and return prompt");
          await call.mark(); assert.equal(call.messages.filter(m => m.kind === "ordinaryFrame").length, ordinary);
          await call.keypad("#"); await call.quietAfterPrivateInput();
          await call.say("Send my appointment email."); await call.mark();
          assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, reviewsBefore, "private selection is not send consent");
          if (scenario === "unknownFirst" || scenario === "unknownSecond" && index === 1) call.child.send({ kind: "loseMail" });
          await call.say("Yes."); await call.mark();
          assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, index + 1);
          const proofs = call.messages.filter(m => m.kind === "verificationEmail").length;
          await call.say("Send my appointment email."); await call.mark();
          assert.equal(call.messages.filter(m => m.kind === "verificationEmail").length, proofs, "a bare repeat reports its existing outcome");
          assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, index + 1);
        }
        const expectedSends = scenario === "unknownFirst" || scenario === "permission" ? 1 : 2;
        const reviews = call.mutations.filter(m => m.path === "/v1/recalls");
        assert.equal(reviews.length, expectedSends);
        assert.deepEqual(reviews.map(row => {
          const operation = resultValue(decodeClinikoReview(row.body!.notes)).request.operation;
          if (operation.kind !== "confirmationResend") throw new Error("wrong native review kind");
          return operation.appointmentId;
        }), expectedSends === 1 ? ["81"] : ["81", "82"]);
        const receipts = await sql<{ request_ref: string; status: string }>`select request_ref, status from confirmation_resend_journal`.execute(call.db);
        const statuses = scenario === "unknownFirst" ? ["unknown"] : scenario === "unknownSecond" ? ["accepted", "unknown"] : Array(expectedSends).fill("accepted");
        assert.deepEqual(receipts.rows.map(row => row.status).sort(), statuses.sort());
        assert.equal(new Set(receipts.rows.map(row => row.request_ref)).size, expectedSends);
        if (scenario !== "permission") {
          const proofs = call.messages.filter(m => m.kind === "verificationEmail").length;
          await call.say("Please send the confirmation email for another appointment."); await call.mark();
          assert.equal(call.messages.filter(m => m.kind === "verificationEmail").length, proofs);
          assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, expectedSends);
        }
        assert.equal(call.mutations.some(m => m.path?.startsWith("/v1/individual_appointments") || m.path?.startsWith("/v1/patients")), false);
        const budgetRef = createHash("sha256").update("abby-cliniko-budget-v1\0synthetic-key-au5").digest("hex");
        const budget = await sql<{ max_per_minute: number; sent_at_ms: unknown }>`select max_per_minute, sent_at_ms from cliniko_request_budgets where budget_ref = ${budgetRef}`.execute(call.db);
        assert.equal(budget.rows.length, 1); assert.equal(budget.rows[0]!.max_per_minute, 180);
        assert.ok(Array.isArray(budget.rows[0]!.sent_at_ms) && budget.rows[0]!.sent_at_ms.length <= 180);
        const codes = call.messages.filter(m => m.kind === "verificationEmail").map(m => m.code!);
        assert.equal(codes.length, taskCount); assert.equal(new Set(codes).size, taskCount);
        const secrets = ["registered-session@example.test", "private-session-chart", "20 Fixture Road", "Séamus Example", ...codes];
        for (const value of secrets) assert.equal(call.messages.some(m => m.kind === "modelTurn" && m.text?.includes(value)), false);
        await call.scan(secrets);
        const backup = execFileSync("pg_dump", [call.connectionString, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 8_000_000 }).toString();
        for (const value of secrets) assert.equal(backup.includes(value), false, "unfiltered backup excludes private canaries");
      }, { taskSequence: true });
    });
