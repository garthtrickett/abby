import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql } from "kysely";
import { createDisposablePostgres } from "../support/disposable-postgres.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { resendTasksFixture } from "../support/resend-task-sequence.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";

const database = await createDisposablePostgres();
after(async () => { await database.close(); });

test("E2E-381 two approved resends retain separate private proofs, native reviews, journal outcomes and TLS emails", async () => {
  await withSmtpVerificationServer(async smtp => {
    const f = await resendTasksFixture(database.db, smtp.config);
    try {
      const firstRef = await f.verifyAndSelect(), first = await f.commit(); assert.equal(first.status, "committed");
      const classify = (text: string) => f.intent(f.turn(crypto.randomUUID(), text));
      assert.deepEqual(resultValue(await classify("Send my appointment email.")), { kind: "notificationOutcome" });
      assert.deepEqual(resultValue(await classify("Send my appointment email to my wife.")), { kind: "clarify", reason: "changeUnsupported" });
      for (const text of ["Did you resend my appointment details to alternate-private@example.test?", "Have you sent my appointment details to my wife?",
        "Was the confirmation email sent to another address?", "Did you resend my confirmation email for another appointment to other@example.test?"])
        assert.deepEqual(resultValue(await classify(text)), { kind: "clarify", reason: "changeUnsupported" });
      assert.deepEqual(resultValue(await classify("Did you send the confirmation email for another appointment?")), { kind: "notificationOutcome" });
      assert.deepEqual(resultValue(await classify("Please send the confirmation email for another appointment.")), { kind: "workflow", operation: "confirmationResend" });
      assert.equal(await f.next(), true); assert.equal(f.input.blocked(), true);
      assert.equal(f.flow.confirmationResendRef, undefined);
      const secondRef = await f.verifyAndSelect(2); assert.notEqual(secondRef, firstRef);
      const second = await f.commit(); assert.equal(second.status, "committed"); assert.notEqual(first.key, second.key);
      assert.equal(f.mail.length, 2); assert.notEqual(f.mail[0]!.code, f.mail[1]!.code);
      assert.equal(f.recalls.length, 2); assert.equal(smtp.messages.length, 2);
      assert.deepEqual(f.recalls.map(row => {
        const operation = resultValue(decodeClinikoReview(row.notes)).request.operation;
        if (operation.kind !== "confirmationResend") throw new Error("wrong native review kind");
        return operation.appointmentId;
      }), ["81", "82"]);
      assert.deepEqual((await f.state()).actions[first.key], first);
      const journal = await sql<{ request_ref: string; status: string }>`select request_ref, status from confirmation_resend_journal where tenant_id = ${f.scope.tenantId}`.execute(database.db);
      assert.deepEqual(journal.rows.map(row => row.status), ["accepted", "accepted"]);
      assert.deepEqual(new Set(journal.rows.map(row => row.request_ref)), new Set([firstRef, secondRef]));
      assert.equal(await f.next(), false); assert.equal(f.mail.length, 2); assert.equal(smtp.messages.length, 2);
      assert.deepEqual(Object.keys((await f.state()).actions), [first.key, second.key]);
      const secrets = ["registered-session@example.test", "20 Fixture Road", "Séamus Example", ...f.mail.map(mail => mail.code)];
      for (const value of secrets) assert.equal(JSON.stringify(await f.flow.publicIntentContext()).includes(value), false);
      // Source scope: all-column content scan. OTP/backup/output scans also require the compiled fixture's canary-clock controls.
      assert.deepEqual(resultValue(await scanPatientDataCanaries(database.db, secrets.slice(0, 3).map((value, i) => ({ label: `resend_${i}`, value })))), []);
    } finally { await f.closeTasks(); }
  });
});

for (const fault of ["unknown", "permission", "withdrawn"] as const)
  test(`E2E-381 ${fault} resend cannot turn a prior request into next-task send authority`, async () => {
    await withSmtpVerificationServer(async smtp => {
      const f = await resendTasksFixture(database.db, smtp.config);
      try {
        await f.verifyAndSelect(); if (fault === "unknown") smtp.fault("dropAfterData");
        const first = await f.commit();
        if (fault === "unknown") {
          assert.ok(["uncertain", "needsReview"].includes(first.status));
          assert.equal(await f.next(), false); assert.equal(f.mail.length, 1);
        } else {
          assert.equal(first.status, "committed");
          if (fault === "withdrawn") { await f.sequence.replace({ enabled: false }); assert.equal(await f.next(), false); }
          else {
            assert.equal(await f.next(), true); f.setPermitted(false);
            for (const digit of f.mail.at(-1)!.code) assert.equal(await f.input.accept(digit), "pending");
            assert.equal(await f.input.accept("#"), "pending"); assert.equal(f.flow.verificationRequired, true);
            assert.equal(f.flow.confirmationResendRef, undefined);
          }
        }
        assert.equal(f.recalls.length, 1); assert.equal(smtp.messages.length, 1);
        assert.deepEqual(Object.keys((await f.state()).actions), [first.key]);
        assert.deepEqual((await f.state()).actions[first.key], first);
      } finally { await f.closeTasks(); }
    });
  });
