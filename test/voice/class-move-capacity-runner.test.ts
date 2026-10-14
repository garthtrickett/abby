import assert from "node:assert/strict";
import test from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-402 compiled corrected cross-service class move waits for real PostgreSQL capacity before renewing consent and writing exactly the selected replacement", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120000,
}, async () => {
  await withClinicalRunner("reschedule", async call => {
    let ticker: ReturnType<typeof setInterval> | undefined, quiet: ReturnType<typeof setInterval> | undefined;
    try {
      await call.say("Start"); await call.mark(); await call.verify();
      await call.say("Appointments"); await call.mark(); await call.say("The first time please."); await call.mark();
      await call.say("Times"); await call.mark(); await call.say("The first time please."); await call.mark();
      await call.say("No, the second time please.");
      assert.match(call.spoken.at(-1)!, /moving your Mat Pilates.*Reformer Pilates.*Second Instructor.*30 minutes/);
      assert.match(call.spoken.at(-1)!, /book the replacement before cancelling the original/); await call.mark();
      await call.say("Yes"); assert.match(call.spoken.at(-1)!, /wait about \d+ seconds.*say yes again/);
      const seconds = Number(/wait about (\d+) seconds/.exec(call.spoken.at(-1)!)![1]);
      assert.ok(seconds >= 1 && seconds <= 60);
      assert.match(call.spoken.at(-1)!, /not reserved/); assert.equal(call.mutations.length, 0);
      assert.equal(call.messages.some(row => row.kind === "classWriteOutcome"), false);
      await call.mark();
      const before = await call.db.selectFrom("cliniko_request_budgets").select(["max_per_minute", "sent_at_ms"]).execute();
      assert.equal(before.length, 1); assert.equal(before[0]!.max_per_minute, 180);
      assert.ok(Array.isArray(before[0]!.sent_at_ms) && before[0]!.sent_at_ms.length > 0);
      const clockAcks = call.messages.filter(row => row.kind === "clockAdvanced").length;
      ticker = setInterval(() => call.child.send({ kind: "advanceClock", milliseconds: 1000 }), 1000);
      quiet = setInterval(() => call.media(false), 20);
      // The database budget uses real database time. Keep that window, real
      // connected-call renewals and real listening timers running unchanged.
      await new Promise<void>(resolve => setTimeout(resolve, seconds * 1000 + 500)); clearInterval(ticker); ticker = undefined; clearInterval(quiet); quiet = undefined;
      assert.ok(call.messages.filter(row => row.kind === "clockAdvanced").length >= clockAcks + Math.max(0, seconds - 1));
      assert.equal(call.mutations.length, 0); assert.equal(call.messages.some(row => row.kind === "classWriteOutcome"), false);
      await call.say("Yes"); assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.");
      const native = call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
      assert.deepEqual(native.map(row => [row.method, row.path]), [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"]]);
      assert.equal(native[0]!.body?.booking_id, "95"); assert.equal(native[1]!.body?.apply_to_repeats, false);
      const recalls = call.mutations.filter(row => row.path === "/v1/recalls"); assert.equal(recalls.length, 1);
      assert.equal(resultValue(decodeClinikoReview(recalls[0]!.body?.notes)).request.operation.kind, "classMove");
      const state = call.messages.filter(row => row.kind === "classMoveState").at(-1)!;
      assert.equal(state.originalActive, false); assert.equal(state.replacementActive, true);
      const after = await call.db.selectFrom("cliniko_request_budgets").select(["max_per_minute", "sent_at_ms"]).execute();
      assert.equal(after[0]!.max_per_minute, 180); assert.ok(Array.isArray(after[0]!.sent_at_ms) && after[0]!.sent_at_ms.length <= 180);
      const code = call.messages.find(row => row.kind === "verificationEmail")!.code!;
      await call.scan([...verificationCanaries, code]);
    } finally { if (ticker) clearInterval(ticker); if (quiet) clearInterval(quiet); }
  }, { classes: true, differentClass: true });
});
