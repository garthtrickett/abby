import assert from "node:assert/strict";
import test from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { prepareClassPassMove, affirmClassPassMove, scanClassPassMovePrivacy } from "../support/class-pass-move-runner.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";

test("E2E-416 compiled pass movement retains its allocated account capacity against a separate process", {
  skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000,
}, async () => {
  await withClinicalRunner("reschedule", async call => {
    await prepareClassPassMove(call, false);
    call.child.send({ kind: "holdClassReplacement" });
    await voiceUntil(() => call.messages.some(m => m.kind === "classReplacementHoldArmed"), "native replacement hold armed");
    const movement = affirmClassPassMove(call);
    try {
      await voiceUntil(() => call.messages.some(m => m.kind === "classReplacementHeld"), "reserved native replacement reached", 90_000);
      const outsider = new PostgresClinikoRequestBudget(call.db, { apiKey: "synthetic-key-au5", maxPerMinute: 180 });
      const held = await call.db.selectFrom("cliniko_request_reservations").selectAll().execute();
      assert.equal(held.length, 1); assert.ok(held[0]!.remaining > 0 && held[0]!.remaining < 180);
      assert.equal((await outsider.claim())?.kind, "rateLimited");
      assert.equal((await outsider.checkHeadroom(1))?.kind, "rateLimited");
      assert.equal((await outsider.withReservation(1, new AbortController().signal, async () => assert.fail("stolen allocation"))).kind, "denied");
    } finally { call.child.send({ kind: "releaseClassReplacement" }); await movement; }
    assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.");
    assert.deepEqual(call.mutations.filter(r => r.path?.startsWith("/v1/attendees")).map(r => [r.method, r.path]),
      [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"], ["PATCH", "/v1/attendees/401"]]);
    assert.equal((await call.db.selectFrom("cliniko_request_reservations").selectAll().execute()).length, 0);
    const budgets = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
    assert.ok(budgets.length > 0 && budgets.every(r => r.max_per_minute === 180 && Array.isArray(r.sent_at_ms) && r.sent_at_ms.length <= 180));
    assert.equal(JSON.stringify(call.spoken).includes("lease_ref"), false); await scanClassPassMovePrivacy(call);
  }, { classes: true, classPassMovement: "full", classPassHistory: 501, classRosterHistory: 201 });
});
