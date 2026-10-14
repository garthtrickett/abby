import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120000 };
type Call = Parameters<Parameters<typeof withClinicalRunner>[1]>[0];
const attendees = (call: Call) => call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
async function prepare(call: Call, transfer: boolean) {
  await call.say("Start"); await call.mark(); await call.verify();
  await call.say("Appointments"); await call.mark(); await call.say("The first time please."); await call.mark();
  await call.say("Times"); await call.mark(); await call.say("The first time please.");
  assert.match(call.spoken.at(-1)!, transfer ? /original pass releases one session.*destination pass uses one session/ : /pass session use unchanged/);
  assert.match(call.spoken.at(-1)!, /staff may need to confirm the replacement/);
  assert.equal(call.mutations.length, 0); await call.mark();
}
async function affirm(call: Call) {
  await call.say("Yes");
  const match = /wait about (\d+) seconds/.exec(call.spoken.at(-1)!); if (!match) return;
  const seconds = Number(match[1]); assert.ok(seconds >= 1 && seconds <= 60);
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
  const secrets = [code, ...verificationCanaries, "811222333444555666", "811222333444555667",
    "private-move-source-entitlement", "private-move-destination-entitlement", "synthetic-private-move-pass-note"];
  const notes = call.mutations.find(row => row.path === "/v1/recalls")?.body?.notes;
  if (typeof notes === "string") {
    const payload = notes.split("\n").find(line => line.startsWith("z1:")); assert.ok(payload);
    secrets.push(payload);
  }
  for (const secret of secrets) assert.equal(JSON.stringify([call.spoken, call.messages.filter(row => ["modelTurn", "ordinaryFinal"].includes(row.kind))]).includes(secret), false);
  // The existing diagnostic accepts at most12 canaries of256 characters per
  // call. Scan every encoded review fragment as well as all plain canaries;
  // full payload equality above alone would miss partial storage leakage.
  const fragments = secrets.flatMap(value => value.length <= 256 ? [value] :
    Array.from({ length: Math.ceil(value.length / 200) }, (_, index) => value.slice(Math.min(index * 200, value.length - 4), index * 200 + 200)));
  for (let offset = 0; offset < fragments.length; offset += 12) await call.scan(fragments.slice(offset, offset + 12));
}
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
