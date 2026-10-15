import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { prepareClassPassMove, affirmClassPassMove, scanClassPassMovePrivacy } from "../support/class-pass-move-runner.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120000 };
describe("compiled complete multi-page pass movements", { concurrency: 2 }, () => {
  for (const mode of ["full", "large", "transfer"] as const) test(`E2E-${mode === "large" ? 412 : 411} compiled ${mode} movement inspects complete mixed history and exact case effects`, options, async () => {
    await withClinicalRunner("reschedule", async call => {
      await prepareClassPassMove(call, mode === "transfer"); await affirmClassPassMove(call);
      assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.");
      const mutations = call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
      assert.deepEqual(mutations.map(row => [row.method, row.path]), [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"], ["PATCH", "/v1/attendees/401"]]);
      const pass = call.messages.filter(row => row.kind === "classPassMoveState").at(-1)!;
      assert.equal(pass.sourceUsed, mode === "transfer" ? 1 : 2); assert.equal(pass.destinationUsed, 2); assert.equal(pass.caseLinked, true);
      const budget = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
      assert.ok(budget.length > 0 && budget.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
      await scanClassPassMovePrivacy(call);
    }, { classes: true, classPassMovement: mode === "transfer" ? "transfer" : "full", classPassHistory: mode === "large" ? 999 : mode === "full" ? 501 : 201, differentClass: mode === "transfer", multipleClasses: mode === "transfer" });
  });
  test("E2E-412 compiled oversized transfer publishes no move proposal and leaves both appointments untouched", options, async () => {
    await withClinicalRunner("reschedule", async call => {
      await call.say("Start"); await call.mark(); await call.verify();
      await call.say("Appointments"); await call.mark(); await call.say("The first time please."); await call.mark();
      await call.say("Times");
      assert.match(call.spoken.at(-1)!, /couldn't find an eligible new appointment time/);
      assert.equal(call.mutations.length, 0);
      await call.mark(); await call.say("Yes"); assert.equal(call.mutations.length, 0);
      await scanClassPassMovePrivacy(call);
    }, { classes: true, classPassMovement: "transfer", classPassHistory: 301, differentClass: true });
  });
  test("E2E-411 compiled same-count change on the last history page leaves the move uncertain without replay", options, async () => {
    await withClinicalRunner("reschedule", async call => {
      await prepareClassPassMove(call, true); call.child.send({ kind: "movePassLastPage" });
      await voiceUntil(() => call.messages.some(row => row.kind === "movePassRaceArmed"), "last-page association race armed");
      await affirmClassPassMove(call);
      assert.notEqual(call.spoken.at(-1), "Your appointment move is confirmed.");
      assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus, "uncertain");
      assert.equal(call.mutations.filter(row => row.path?.startsWith("/v1/attendees")).length, 3);
      const before = call.mutations.length; await call.mark(); await call.say("What happened?"); assert.equal(call.mutations.length, before);
      await scanClassPassMovePrivacy(call);
    }, { classes: true, classPassMovement: "transfer", classPassHistory: 201, differentClass: true });
  });
});
