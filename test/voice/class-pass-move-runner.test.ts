import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120000 };
const attendees = (call: Parameters<Parameters<typeof withClinicalRunner>[1]>[0]) => call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
import { prepareClassPassMove as prepare, affirmClassPassMove as affirm, scanClassPassMovePrivacy as privacy } from "../support/class-pass-move-runner.ts";
describe("compiled native pass movement", { concurrency: 2 }, () => {
  for (const mode of ["full", "transfer"] as const)
    test(`E2E-410 compiled ${mode} pass move binds played effect, native case association and unchanged physical quota`, options, async () => {
      await withClinicalRunner("reschedule", async call => {
        await prepare(call, mode === "transfer"); await affirm(call);
        assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.", JSON.stringify({ outcomes: call.messages.filter(row => row.kind === "classWriteOutcome"), native: attendees(call) }));
        assert.deepEqual(attendees(call).map(row => [row.method, row.path]), [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"], ["PATCH", "/v1/attendees/401"]]);
        assert.equal(attendees(call)[0]!.body?.patient_case_id, undefined);
        assert.equal(attendees(call)[1]!.body?.apply_to_repeats, false);
        assert.deepEqual(attendees(call)[2]!.body, { patient_case_id: mode === "transfer" ? "811222333444555667" : "811222333444555666" });
        const review = resultValue(decodeClinikoReview(call.mutations.find(row => row.path === "/v1/recalls")!.body?.notes)).request.operation;
        assert.ok(review.kind === "classMove" && review.pass); assert.equal(review.pass.source.effect, "releaseOne");
        if (mode === "transfer") { assert.notEqual(review.practitionerId, review.newPractitionerId); assert.notEqual(review.appointmentTypeId, review.newAppointmentTypeId); }
        const state = call.messages.filter(row => row.kind === "classPassMoveState").at(-1)!;
        assert.equal(state.sourceUsed, mode === "transfer" ? 1 : 2); assert.equal(state.destinationUsed, 2); assert.equal(state.caseLinked, true);
        assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus, "committed");
        const budgets = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
        assert.ok(budgets.length > 0); assert.ok(budgets.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
        await privacy(call);
      }, { classes: true, classPassMovement: mode, differentClass: mode === "transfer", multipleClasses: mode === "transfer" });
    });
  for (const fault of ["denyMovePass", "changeMovePass", "moveCaseRule", "loseAssociation", "movePassRace"] as const)
    test(`E2E-410 compiled pass movement ${fault} preserves truthful native outcome without replay`, options, async () => {
      await withClinicalRunner("reschedule", async call => {
        await prepare(call, true); call.child.send({ kind: fault });
        await voiceUntil(() => call.messages.some(row => row.kind === (fault === "movePassRace" ? "movePassRaceArmed" : "movePassChanged")), "private pass move fault armed");
        await affirm(call);
        const beforeSend = ["denyMovePass", "changeMovePass", "moveCaseRule"].includes(fault);
        assert.equal(attendees(call).length, beforeSend ? 0 : 3);
        if (beforeSend) {
          // The owned review journals the played proposal. A case-rule change
          // is caught by the complete native observation after that journal,
          // before any clinical mutation. Selection/authority denial is earlier.
          assert.equal(call.mutations.length, fault === "moveCaseRule" ? 1 : 0);
          if (fault === "moveCaseRule") assert.equal(call.mutations[0]!.path, "/v1/recalls");
        }
        assert.notEqual(call.spoken.at(-1), "Your appointment move is confirmed.");
        if (!beforeSend) {
          assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus, "uncertain");
          const count = call.mutations.length; await call.mark(); await call.say("What happened?"); assert.equal(call.mutations.length, count);
          assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
          const state = call.messages.filter(row => row.kind === "classMoveState").at(-1)!;
          assert.equal(state.originalActive, false); assert.equal(state.replacementActive, true);
        }
        await privacy(call);
      }, { classes: true, classPassMovement: "transfer", differentClass: true });
    });
});
