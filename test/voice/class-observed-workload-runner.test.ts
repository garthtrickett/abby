import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { prepareClassPassMove, affirmClassPassMove, scanClassPassMovePrivacy } from "../support/class-pass-move-runner.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
describe("compiled observed class movement workload", { concurrency: 2 }, () => {
  for (const roster of [100, 201] as const)
    test(`E2E-415 compiled ${roster}-row class attendance history completes one exact pass move under the physical quota`, options, async () => {
      await withClinicalRunner("reschedule", async call => {
        await prepareClassPassMove(call, false); await affirmClassPassMove(call);
        assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.");
        const mutations = call.mutations.filter(r => r.path?.startsWith("/v1/attendees"));
        assert.deepEqual(mutations.map(r => [r.method, r.path]), [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"], ["PATCH", "/v1/attendees/401"]]);
        const pass = call.messages.filter(r => r.kind === "classPassMoveState").at(-1)!;
        assert.equal(pass.sourceUsed, 2); assert.equal(pass.destinationUsed, 2); assert.equal(pass.caseLinked, true);
        const budgets = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
        assert.ok(budgets.length > 0 && budgets.every(r => r.max_per_minute === 180 && Array.isArray(r.sent_at_ms) && r.sent_at_ms.length <= 180));
        assert.equal(JSON.stringify(call.spoken).includes("nativeWorkload"), false);
        await scanClassPassMovePrivacy(call);
      }, { classes: true, classPassMovement: "full", classPassHistory: 501, classRosterHistory: roster });
    });

  test("E2E-415 compiled combined pass and inactive-roster history withholds an oversized move before review or clinical mutation", options, async () => {
    await withClinicalRunner("reschedule", async call => {
      await call.say("Start"); await call.mark(); await call.verify();
      await call.say("Appointments"); await call.mark(); await call.say("The first time please."); await call.mark();
      await call.say("Times");
      assert.match(call.spoken.at(-1)!, /couldn't find an eligible new appointment time/);
      assert.equal(call.mutations.length, 0); await call.mark(); await call.say("Yes");
      assert.equal(call.mutations.length, 0); await scanClassPassMovePrivacy(call);
    }, { classes: true, classPassMovement: "full", classPassHistory: 999, classRosterHistory: 201 });
  });
});
