import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120000 };
const caseId = "811222333444555666", entitlement = "synthetic-private-pass-entitlement";
type Call = Parameters<Parameters<typeof withClinicalRunner>[1]>[0];
async function prepare(call: Call) {
  await call.say("Start"); await call.mark(); await call.verify();
  await call.say("Times"); await call.mark(); await call.say("The first time please.");
  assert.match(call.spoken.at(-1)!, /uses one session from your approved class pass/);
  assert.equal(call.mutations.length, 0); await call.mark();
}
async function privacy(call: Call) {
  const code = call.messages.find(row => row.kind === "verificationEmail")!.code!;
  const secrets = [code, ...verificationCanaries, caseId, entitlement, "private-pass-name-canary", "private-pass-notes-canary", "private-pass-referral-canary"];
  for (const secret of secrets) assert.equal(JSON.stringify([call.spoken, call.messages.filter(row => ["modelTurn", "ordinaryFinal"].includes(row.kind))]).includes(secret), false);
  await call.scan(secrets);
}
async function affirm(call: Call) {
  await call.say("Yes");
  const matched = /wait about (\d+) seconds/.exec(call.spoken.at(-1)!);
  if (!matched) return;
  const seconds = Number(matched[1]); assert.ok(seconds >= 1 && seconds <= 60);
  assert.match(call.spoken.at(-1)!, /say yes again/); assert.match(call.spoken.at(-1)!, /not reserved/);
  assert.equal(call.mutations.length, 0); await call.mark();
  let ticker: ReturnType<typeof setInterval> | undefined, quiet: ReturnType<typeof setInterval> | undefined;
  try {
    ticker = setInterval(() => call.child.send({ kind: "advanceClock", milliseconds: 1000 }), 1000);
    quiet = setInterval(() => call.media(false), 20);
    await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000 + 500));
    assert.equal(call.mutations.length, 0, "capacity waiting does not dispatch an earlier affirmative");
  } finally { if (ticker) clearInterval(ticker); if (quiet) clearInterval(quiet); }
  await call.say("Yes");
}

describe("compiled native pass booking", { concurrency: 2 }, () => {
for (const fault of ["none", "denyPass", "changePass", "depletePass", "loseWrite", "extraPassUseAfterWrite"] as const)
  test(`E2E-406 separately compiled pass booking ${fault} uses ordinary consent, shared native budget and exact creation acknowledgement`, options, async () => {
    await withClinicalRunner("book", async call => {
      await prepare(call);
      if (fault !== "none") {
        call.child.send({ kind: fault });
        if (["denyPass", "changePass", "depletePass"].includes(fault)) await voiceUntil(() => call.messages.some(row => row.kind === "passChanged"), "private pass authority/counter change");
        if (fault === "extraPassUseAfterWrite") await voiceUntil(() => call.messages.some(row => row.kind === "passRaceArmed"), "case consumption race");
      }
      await affirm(call);
      const sent = call.mutations.filter(row => row.path === "/v1/attendees");
      const beforeSend = ["denyPass", "changePass", "depletePass"].includes(fault);
      assert.equal(sent.length, Number(!beforeSend));
      if (sent.length) {
        assert.equal(sent[0]!.body?.patient_case_id, caseId);
        const review = resultValue(decodeClinikoReview(call.mutations.find(row => row.path === "/v1/recalls")!.body?.notes));
        assert.equal(review.request.operation.kind, "classBook");
        if (review.request.operation.kind !== "classBook") assert.fail("wrong pass review");
        assert.equal(review.request.operation.pass?.patientCaseId, caseId); assert.equal(review.request.operation.pass?.used, 1);
      } else assert.equal(call.mutations.length, 0);
      if (fault === "none" || fault === "extraPassUseAfterWrite") {
        const budgets = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
        assert.equal(call.spoken.at(-1), "Your booking is confirmed.", JSON.stringify(budgets.map(row => ({ used: Array.isArray(row.sent_at_ms) ? row.sent_at_ms.length : -1, limit: row.max_per_minute }))));
        assert.ok(budgets.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
        assert.ok(call.messages.some(row => row.kind === "providerRequest" && row.path === `/v1/patient_cases/${caseId}/attendees`));
        assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus, "committed");
        const dispatch = call.messages.findIndex(row => row.kind === "providerRequest" && row.method === "POST" && row.path === "/v1/attendees");
        assert.ok(dispatch >= 0);
        assert.equal(call.messages.slice(dispatch + 1).some(row => row.kind === "providerRequest" && row.method === "GET"), false);
        await call.mark(); await call.say("What happened?");
        assert.match(call.spoken.at(-1)!, /confirmed/);
        assert.equal(call.mutations.filter(row => row.path === "/v1/attendees").length, 1);
      } else {
        assert.equal(call.spoken.at(-1)!.includes("is confirmed"), false);
        if (!beforeSend) {
          assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
          await call.mark(); await call.say("What happened?");
          assert.equal(call.mutations.filter(row => row.path === "/v1/attendees").length, 1);
        }
      }
      await privacy(call);
    }, { classes: true, classPasses: true });
  });

});
