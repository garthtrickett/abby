import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "kysely";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
for (const scenario of ["last", "drift"] as const) {
  test(`E2E-376 signed compiled resend paging ${scenario} keeps choices private and tied to played native pages`, options, async () => {
    await withClinicalRunner("confirmationResend", async call => {
      call.child.send({ kind: "pagedAppointments" }); await voiceUntil(() => call.messages.some(m => m.kind === "appointmentsPaged"), "seven synthetic appointments");
      await call.say("Please resend my appointment email."); await call.mark(); await call.verify();
      await voiceUntil(() => call.spoken.some(s => s.includes("Press 4 for the next")), "private paged menu");
      const ordinary = call.messages.filter(m => m.kind === "ordinaryFrame").length;
      await call.keypad("4"); // No played page yet: ignore this navigation.
      await call.mark();
      if (scenario === "drift") {
        call.child.send({ kind: "changeAppointments" }); await voiceUntil(() => call.messages.some(m => m.kind === "appointmentsChanged"), "changed native roster");
        await call.keypad("4"); await voiceUntil(() => call.messages.some(m => m.kind === "privatePageResult" && m.accepted === false), "withdrawn changed page");
        assert.equal(call.mutations.length, 0);
        const rows = await sql<{ count: string }>`select count(*)::text as count from confirmation_resend_journal`.execute(call.db);
        assert.equal(rows.rows[0]!.count, "0"); return;
      }
      await call.digit("4"); assert.match(call.spoken.at(-1)!, /11 October/); await call.mark();
      await call.digit("5"); assert.match(call.spoken.at(-1)!, /8 October/); await call.mark();
      await call.digit("4"); await call.mark(); await call.digit("4");
      assert.match(call.spoken.at(-1)!, /14 October/); assert.doesNotMatch(call.spoken.at(-1)!, /Press 4/); await call.mark();
      await call.keypad("4"); await call.keypad("2"); // Boundary and absent second ordinal preserve the last page.
      for (let i = 0; i < 12; i++) call.media(true);
      try { await call.digit("1"); }
      catch (error) {
        // Fixed phase results only; no speech, native IDs, recipient or caller verification data.
        const stages = Object.fromEntries(["privateMenuResult", "privatePageResult", "privateChoiceResult"].map(kind =>
          [kind, call.messages.filter(message => message.kind === kind).map(message => message.accepted)]));
        throw new Error(`private resend selection failed: ${JSON.stringify(stages)}`, { cause: error });
      }
      await call.mark();
      await voiceUntil(() => call.spoken.at(-1)?.includes("Press pound to return") === true, "private selected recipient complete"); await call.mark();
      assert.equal(call.messages.filter(m => m.kind === "ordinaryFrame").length, ordinary);
      assert.equal(call.mutations.length, 0);
      await call.keypad("#"); await call.quietAfterPrivateInput(); await call.say("Send my appointment email."); await call.mark();
      assert.equal(call.mutations.length, 0); await call.say("Yes"); await call.mark();
      const reviews = call.mutations.filter(m => m.path === "/v1/recalls"); assert.equal(reviews.length, 1);
      const native = resultValue(decodeClinikoReview(reviews[0]!.body!.notes)).request.operation;
      assert.equal(native.kind, "confirmationResend"); assert.equal((native as Extract<typeof native, { kind: "confirmationResend" }>).appointmentId, "87");
      const receipt = await sql<{ status: string }>`select status from confirmation_resend_journal`.execute(call.db); assert.deepEqual(receipt.rows.map(r => r.status), ["accepted"]);
      await call.scan(["registered-session@example.test", "private-session-chart", "482746192837465", "20 Fixture Road", call.messages.find(m => m.kind === "verificationEmail")!.code!]);
    });
  });
}
