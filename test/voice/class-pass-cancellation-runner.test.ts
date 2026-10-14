import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import type { ClassPassCancellationEffect } from "../../src/standalone/cliniko-class-pass-cancellation.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120000 };
type Call = Parameters<Parameters<typeof withClinicalRunner>[1]>[0];
const caseId = "811222333444555666", entitlement = "synthetic-private-cancel-entitlement";
async function prepare(call: Call, effect: ClassPassCancellationEffect) {
  await call.say("Start"); await call.mark(); await call.verify();
  await call.say("Appointments"); await call.mark(); await call.say("Cancel that appointment.");
  assert.match(call.spoken.at(-1)!, effect === "releaseOne" ? /One session will stop counting as used/ : effect === "unchanged" ? /usage will stay unchanged/ : /will count as one used pass session/);
  assert.equal(call.mutations.length, 0); await call.mark();
}
async function affirm(call: Call) {
  await call.say("Yes");
  const match = /wait about (\d+) seconds/.exec(call.spoken.at(-1)!); if (!match) return;
  const seconds = Number(match[1]); assert.ok(seconds >= 1 && seconds <= 60); assert.match(call.spoken.at(-1)!, /haven't cancelled/);
  assert.match(call.spoken.at(-1)!, /say yes again/); assert.equal(call.mutations.length, 0); await call.mark();
  let ticker: ReturnType<typeof setInterval> | undefined, quiet: ReturnType<typeof setInterval> | undefined;
  try {
    ticker = setInterval(() => call.child.send({ kind: "advanceClock", milliseconds: 1000 }), 1000);
    quiet = setInterval(() => call.media(false), 20);
    await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000 + 500)); assert.equal(call.mutations.length, 0);
  } finally { if (ticker) clearInterval(ticker); if (quiet) clearInterval(quiet); }
  await call.say("Yes");
}
async function privacy(call: Call) {
  const code = call.messages.find(row => row.kind === "verificationEmail")!.code!;
  const secrets = [code, ...verificationCanaries, caseId, entitlement, "private-cancel-case-name", "private-cancel-case-notes", "private-cancel-case-referral"];
  for (const secret of secrets) assert.equal(JSON.stringify([call.spoken, call.messages.filter(row => ["modelTurn", "ordinaryFinal"].includes(row.kind))]).includes(secret), false);
  await call.scan(secrets);
}
const cases: { effect: ClassPassCancellationEffect; fault: string }[] = [
  ...(["releaseOne", "unchanged", "consumeOne"] as const).map(effect => ({ effect, fault: "none" })),
  ...["denyPassCancellation", "changePassCancellation", "changePassCancelRule", "loseWrite", "passCancelRace"].map(fault => ({ effect: "releaseOne" as const, fault })),
];
describe("compiled pass attendance cancellation", { concurrency: 2 }, () => {
  for (const { effect, fault } of cases)
    test(`E2E-407 compiled ${effect} cancellation ${fault} retains played consent, real quota waits and exact case inspection`, options, async () => {
      await withClinicalRunner("cancel", async call => {
        await prepare(call, effect);
        if (fault !== "none") {
          call.child.send({ kind: fault });
          if (["denyPassCancellation", "changePassCancellation", "changePassCancelRule"].includes(fault)) await voiceUntil(() => call.messages.some(row => row.kind === "passCancelChanged"), "private cancellation case change");
          if (fault === "passCancelRace") await voiceUntil(() => call.messages.some(row => row.kind === "passCancelRaceArmed"), "cancellation case race armed");
        }
        await affirm(call);
        const beforeSend = ["denyPassCancellation", "changePassCancellation", "changePassCancelRule"].includes(fault);
        const sent = call.mutations.filter(row => row.path?.startsWith("/v1/attendees")); assert.equal(sent.length, Number(!beforeSend));
        if (sent.length) {
          assert.equal(sent[0]!.method, "PATCH"); assert.equal(sent[0]!.path, "/v1/attendees/101/cancel");
          assert.deepEqual(sent[0]!.body, { cancellation_reason: 50, apply_to_repeats: false });
          const op = resultValue(decodeClinikoReview(call.mutations.find(row => row.path === "/v1/recalls")!.body?.notes)).request.operation;
          assert.equal(op.kind, "classCancel"); if (op.kind !== "classCancel") assert.fail("wrong pass cancellation review");
          assert.equal(op.pass?.patientCaseId, caseId); assert.equal(op.pass?.effect, effect);
        } else assert.equal(call.mutations.length, 0);
        if (fault === "none") {
          assert.equal(call.spoken.at(-1)!, "Your appointment cancellation is confirmed.");
          assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus, "committed");
          const budgets = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
          assert.ok(budgets.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
        } else {
          assert.equal(call.spoken.at(-1)!.includes("is confirmed"), false);
          if (!beforeSend) { await call.mark(); await call.say("What happened?"); assert.equal(call.mutations.filter(row => row.path?.startsWith("/v1/attendees")).length, 1); }
        }
        await privacy(call);
      }, { classes: true, classPassCancellation: effect });
    });
});
