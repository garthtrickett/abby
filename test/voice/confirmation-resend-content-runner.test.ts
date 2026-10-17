import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

for (const variant of ["telehealth", "cancelled"] as const) test(`E2E-380 signed compiled ${variant} email uses private current content and separate consent`,
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async t => {
    await withClinicalRunner("confirmationResend", async call => {
      await call.say(`Please resend my ${variant} appointment confirmation email.`); await call.mark(); await call.verify();
      await voiceUntil(() => call.spoken.some(s => s.includes("Choose the appointment")), "private content menu"); await call.mark();
      if (variant === "cancelled") assert.match(call.spoken.at(-1)!, /cancelled/);
      const ordinary = call.messages.filter(m => m.kind === "ordinaryFrame").length;
      await call.digit("1"); await call.mark();
      await voiceUntil(() => call.spoken.at(-1)?.includes("Press pound to return") === true, "private readback complete"); await call.mark();
      const choice = call.messages.filter(row => row.kind === "privateChoiceResult").at(-1);
      assert.ok(choice?.diagnostic, "completed selection supplies aggregate source observations");
      t.diagnostic(JSON.stringify({ phase: "privateChoiceComplete", scope: "wholeCallSources", sources: choice.diagnostic }));
      assert.equal(call.messages.filter(m => m.kind === "ordinaryFrame").length, ordinary);
      assert.equal(call.mutations.length, 0);
      await call.keypad("#"); await call.quietAfterPrivateInput(); await call.say("Send my appointment email."); await call.mark();
      assert.equal(call.mutations.length, 0); await call.say("Yes"); await call.mark();
      await voiceUntil(() => call.messages.some(m => m.kind === "resendContentResult"), "fixed content acceptance result");
      assert.deepEqual(call.messages.filter(m => m.kind === "resendContentResult"), [{ kind: "resendContentResult", accepted: true, allowed: true }]);
      const reviews = call.mutations.filter(m => m.path === "/v1/recalls"); assert.equal(reviews.length, 1);
      const native = resultValue(decodeClinikoReview(reviews[0]!.body!.notes)).request.operation;
      assert.equal(native.kind, "confirmationResend");
      if (native.kind !== "confirmationResend") throw new Error("wrong operation");
      assert.equal(native.contentKind, variant === "telehealth" ? "activeTelehealth" : "cancelled");
      assert.equal(call.mutations.some(m => m.path?.startsWith("/v1/individual_appointments") || m.path?.startsWith("/v1/attendees")), false);
      const receipt = await sql<{ status: string }>`select status from confirmation_resend_journal`.execute(call.db);
      assert.deepEqual(receipt.rows.map(r => r.status), ["accepted"]);
      const secrets = ["https://synthetic-clinic.cliniko.com/c/private-patient-join", "registered-session@example.test", "private-session-chart", "482746192837465", "20 Fixture Road", call.messages.find(m => m.kind === "verificationEmail")!.code!];
      for (const secret of secrets) assert.equal(call.messages.some(m => m.kind === "modelTurn" && m.text?.includes(secret)), false);
      await call.scan(secrets);
    }, { resendContent: variant });
  });
