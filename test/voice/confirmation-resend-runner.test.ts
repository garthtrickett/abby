import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sql } from "kysely";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
describe("private confirmation resends through the signed compiled server", { concurrency: 2 }, () => {
  for (const scenario of ["accepted", "decline", "permission", "source", "stop", "unknown"] as const) {
    test(`E2E-375 compiled resend ${scenario} uses private media and separate consent`, options, async () => {
      await withClinicalRunner("confirmationResend", async call => {
        await call.say("Please resend my appointment confirmation email."); await call.mark();
        assert.equal(call.mutations.length, 0);
        await call.verify();
        await voiceUntil(() => call.spoken.some(s => s.includes("Choose the appointment")), "private resend menu");
        await call.keypad("1"); // An unplayed selection must not choose the first appointment.
        const ordinaryBefore = call.messages.filter(m => m.kind === "ordinaryFrame").length;
        // Private speech/late OTP frames are discarded, never transcribed.
        for (let i = 0; i < 15; i++) call.media(true);
        await call.mark();
        try { await call.digit("2"); } catch (error) {
          assert.fail(`Private choice failed; menu/choice results: ${JSON.stringify(call.messages.filter(m => ["privateMenuResult", "privateChoiceResult"].includes(m.kind)))}; ${error instanceof Error ? error.message : "unknown"}`);
        }
        await voiceUntil(() => call.spoken.some(s => s.includes("Please check the email recipient")), "private recipient readback");
        for (let i = 0; i < 15; i++) call.media(true);
        if (scenario === "stop") {
          await call.keypad("*");
          await voiceUntil(() => call.messages.some(m => m.kind === "privateChoiceResult" && m.accepted === false), "private resend stopped before preparation");
          assert.equal(call.mutations.length, 0);
          const retained = await sql<{ count: string }>`select count(*)::text as count from confirmation_resend_journal`.execute(call.db);
          assert.equal(retained.rows[0]!.count, "0");
          await call.scan(["registered-session@example.test", "private-session-chart", call.messages.find(m => m.kind === "verificationEmail")!.code!]);
          return;
        }
        await call.mark();
        await voiceUntil(() => call.spoken.at(-1)?.includes("Press pound to return") === true, "private completion prompt"); await call.mark();
        assert.equal(call.messages.filter(m => m.kind === "ordinaryFrame").length, ordinaryBefore);
        assert.equal(call.mutations.length, 0);
        await call.keypad("#"); await call.quietAfterPrivateInput();
        if (scenario === "permission") call.child.send({ kind: "denyPermission" });
        if (scenario === "source") {
          call.child.send({ kind: "changePolicy" }); await voiceUntil(() => call.messages.some(m => m.kind === "policyChanged"), "withdrawn resend owner approval");
        }
        await call.say("Send my appointment email."); await call.mark();
        assert.equal(call.mutations.length, 0);
        if (scenario === "permission" || scenario === "source") { await call.scan(["registered-session@example.test", "private-session-chart", "20 Fixture Road", call.messages.find(m => m.kind === "verificationEmail")!.code!]); return; }
        if (scenario === "unknown") call.child.send({ kind: "loseMail" });
        await call.say(scenario === "decline" ? "No" : "Yes"); await call.mark();
        const recalls = call.mutations.filter(m => m.path === "/v1/recalls");
        assert.equal(recalls.length, scenario === "decline" ? 0 : 1);
        const receipts = await sql<{ status: string }>`select status from confirmation_resend_journal`.execute(call.db);
        assert.deepEqual(receipts.rows.map(r => r.status), scenario === "decline" ? [] : [scenario === "unknown" ? "unknown" : "accepted"]);
        if (recalls.length) {
          const native = resultValue(decodeClinikoReview(recalls[0]!.body!.notes)).request.operation;
          assert.equal(native.kind, "confirmationResend");
          assert.equal((native as Extract<typeof native, { kind: "confirmationResend" }>).appointmentId, "82");
        }
        assert.equal(call.mutations.some(m => m.path?.startsWith("/v1/individual_appointments") || m.path?.startsWith("/v1/patients")), false);
        await call.say("Was my email sent?"); await call.mark();
        await call.say("Send my appointment email."); await call.mark();
        assert.equal(call.mutations.filter(m => m.path === "/v1/recalls").length, recalls.length);
        for (const secret of ["registered-session@example.test", "20 Fixture Road", "482746192837465"]) assert.equal(call.messages.some(m => m.kind === "modelTurn" && m.text?.includes(secret)), false);
        const code = call.messages.find(m => m.kind === "verificationEmail")!.code!;
        await call.scan(["registered-session@example.test", "private-session-chart", "482746192837465", "20 Fixture Road", "Séamus Example", code]);
      });
    });
  }
});
