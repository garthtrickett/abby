import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withClinicalRunner } from "../support/clinical-runner-call.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { voiceUntil } from "../support/cliniko-workflow-voice.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
type Call = Parameters<Parameters<typeof withClinicalRunner>[1]>[0];
const attendances = (call: Call) => call.mutations.filter(row => row.path?.startsWith("/v1/attendees"));
async function prepare(call: Call) {
  await call.say("Start"); assert.match(call.spoken.at(-1)!, /six-digit code.*keypad/); await call.mark(); await call.verify();
  await call.say("Appointments"); assert.match(call.spoken.at(-1)!, /Which appointment/); await call.mark();
  await call.say("The first time please."); assert.match(call.spoken.at(-1)!, /selected your appointment/); await call.mark();
  await call.say("Times"); assert.match(call.spoken.at(-1)!, /Option one|option one/i); await call.mark();
  await call.say("The first time please.");
  assert.match(call.spoken.at(-1)!, /book the replacement before cancelling the original/);
  assert.match(call.spoken.at(-1)!, /No move fee applies/);
  assert.equal(call.mutations.length, 0);
}

test("E2E-400 compiled class movement inspects both native legs through real host rebinding and PostgreSQL account budget", options, async () => {
  await withClinicalRunner("reschedule", async call => {
    await prepare(call); await call.mark(); await call.say("Yes");
    assert.equal(call.spoken.at(-1), "Your appointment move is confirmed.", JSON.stringify({
      write: call.messages.filter(row => row.kind === "classWriteOutcome"),
      permission: call.messages.filter(row => row.kind === "classPermissionDecision").slice(-3),
      native: attendances(call).map(row => ({ method: row.method, path: row.path })),
    }));
    assert.deepEqual(attendances(call).map(row => [row.method, row.path]), [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/101/cancel"]]);
    assert.equal(attendances(call)[0]!.body?.booking_id, "94"); assert.equal(attendances(call)[1]!.body?.apply_to_repeats, false);
    const review = call.mutations.filter(row => row.path === "/v1/recalls"); assert.equal(review.length, 1);
    assert.equal(resultValue(decodeClinikoReview(review[0]!.body?.notes)).request.operation.kind, "classMove");
    const state = call.messages.filter(row => row.kind === "classMoveState").at(-1)!;
    assert.equal(state.originalActive, false); assert.equal(state.replacementActive, true);
    assert.equal(call.messages.some(row => row.kind === "providerRequest" && row.path?.includes("individual_appointments")), false);
    const rows = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
    assert.equal(rows.length, 1); assert.ok(Array.isArray(rows[0]!.sent_at_ms));
    assert.ok(rows[0]!.sent_at_ms.length > 100 && rows[0]!.sent_at_ms.length <= rows[0]!.max_per_minute);
    const code = call.messages.find(row => row.kind === "verificationEmail")!.code!;
    for (const secret of [code, ...verificationCanaries]) assert.equal(JSON.stringify([call.spoken, call.messages.filter(row => row.kind === "modelTurn" || row.kind === "ordinaryFinal")]).includes(secret), false);
    await call.scan([code, ...verificationCanaries]);
  }, { classes: true });
});

describe("compiled class movement denial and partial recovery", { concurrency: 2 }, () => {
  test("E2E-400 compiled catalogue class movement keeps its approved private service selection", options, async () => {
    await withClinicalRunner("reschedule", async call => {
      await prepare(call); await call.mark(); await call.say("Yes");
      assert.equal(call.spoken.at(-1), "Your appointment move is confirmed."); assert.equal(attendances(call).length, 2);
      await call.scan(verificationCanaries);
    }, { classes: true, multipleClasses: true });
  });

  for (const lost of ["review", "replacement", "original"] as const)
    test(`E2E-400 compiled lost ${lost} response stays uncertain without replay or rollback`, options, async () => {
      await withClinicalRunner("reschedule", async call => {
        await prepare(call); await call.mark(); call.child.send({ kind: lost === "review" ? "loseReview" : lost === "replacement" ? "loseWrite" : "loseOriginal" });
        await call.say("Yes");
        const expected = lost === "review" ? 0 : lost === "replacement" ? 1 : 2;
        assert.equal(attendances(call).length, expected); assert.equal(call.mutations.filter(row => row.path === "/v1/recalls").length, 1);
        assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus, "uncertain");
        assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
        const before = call.mutations.length; await call.mark(); await call.say("What happened?");
        assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
        assert.equal(call.mutations.length, before);
        const state = call.messages.filter(row => row.kind === "classMoveState").at(-1)!;
        assert.equal(state.originalActive, lost !== "original"); assert.equal(state.replacementActive, lost !== "review");
        await call.scan(verificationCanaries);
      }, { classes: true });
    });

  for (const fault of ["denyPermission", "denyClassPermission", "revokeClass", "revokeDestination", "revokeMove", "changeMember", "changePolicy", "fillClass"] as const)
    test(`E2E-400 compiled ${fault} after played consent prevents class movement`, options, async () => {
      await withClinicalRunner("reschedule", async call => {
        await prepare(call); await call.mark(); call.child.send({ kind: fault });
        const acknowledgement = fault === "revokeClass" ? "classRevoked" : fault === "revokeDestination" ? "destinationRevoked" : fault === "revokeMove" ? "moveRevoked" :
          fault === "changeMember" ? "membershipChanged" : fault === "fillClass" ? "classOccupied" : undefined;
        if (acknowledgement) await voiceUntil(() => call.messages.some(row => row.kind === acknowledgement), "current class move authority or capacity change");
        await call.say("Yes"); assert.equal(call.mutations.length, 0);
        assert.notEqual(call.spoken.at(-1), "Your appointment move is confirmed.");
        await call.scan(verificationCanaries);
      }, { classes: true });
    });

  for (const fault of ["denyPermission", "loseMail"] as const)
    test(`E2E-400 compiled move ${fault} cannot issue patient authority`, options, async () => {
      await withClinicalRunner("reschedule", async call => {
        call.child.send({ kind: fault }); await call.say("Start"); await call.mark();
        if (fault === "denyPermission") {
          await voiceUntil(() => call.messages.some(row => row.kind === "permissionDecision" && row.allowed === false), "class move caller denial");
          assert.equal(call.messages.some(row => row.kind === "verificationEmail"), false);
        } else {
          await voiceUntil(() => call.messages.some(row => row.kind === "verificationEmail" && row.accepted === false), "class move code delivery failure");
          await call.verify(false);
        }
        assert.equal(call.mutations.length, 0); await call.scan(verificationCanaries);
      }, { classes: true });
    });

  for (const reason of ["denyOriginalCancel", "overbookAfterWrite", "overbookExhaustedRecovery"] as const)
    test(`E2E-400 compiled ${reason} cancels only the replacement and ${reason === "overbookExhaustedRecovery" ? "keeps exhausted-budget verification unresolved" : "proves the original remains active"}`, options, async () => {
      await withClinicalRunner("reschedule", async call => {
        await prepare(call); await call.mark(); call.child.send({ kind: reason });
        if (reason !== "denyOriginalCancel") await voiceUntil(() => call.messages.some(row => row.kind === "classRaceArmed"), "compiled class race armed");
        await call.say("Yes");
        assert.deepEqual(attendances(call).map(row => [row.method, row.path]), [["POST", "/v1/attendees"], ["PATCH", "/v1/attendees/401/cancel"]]);
        assert.equal(attendances(call)[1]!.body?.apply_to_repeats, false);
        const budgets = await call.db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
        const expected = reason === "overbookExhaustedRecovery" ? "uncertain" : "rejected";
        assert.equal(call.messages.filter(row => row.kind === "classWriteOutcome").at(-1)!.actionStatus, expected, JSON.stringify({
          budget: budgets.map(row => ({ used: Array.isArray(row.sent_at_ms) ? row.sent_at_ms.length : -1, limit: row.max_per_minute })),
          phases: call.messages.filter(row => row.kind === "classPermissionDecision").slice(-6).map(row => ({ phase: row.phase, allowed: row.allowed })),
          lastReads: call.messages.filter(row => row.kind === "providerRequest").slice(-8).map(row => row.path?.startsWith("/v1/patients/") ? "patient" : row.path?.startsWith("/v1/attendees/") ? "ownAttendance" : row.path === "/v1/attendees" ? "capacity" : row.path?.startsWith("/v1/group_appointments") ? "class" : "metadata"),
        }));
        if (reason === "overbookExhaustedRecovery") {
          assert.ok(call.messages.some(row => row.kind === "classRecoveryBudgetConsumed"));
          assert.equal(budgets.length, 1); assert.equal(budgets[0]!.max_per_minute, 180);
          assert.ok(Array.isArray(budgets[0]!.sent_at_ms)); assert.equal(budgets[0]!.sent_at_ms.length, 180);
          assert.match(call.spoken.at(-1)!, /can't confirm|couldn't confirm|not confirmed|unconfirmed/i);
        } else assert.ok(budgets.every(row => row.max_per_minute === 180 && Array.isArray(row.sent_at_ms) && row.sent_at_ms.length <= 180));
        const state = call.messages.filter(row => row.kind === "classMoveState").at(-1)!;
        assert.equal(state.originalActive, true); assert.equal(state.replacementActive, false);
        assert.notEqual(call.spoken.at(-1), "Your appointment move is confirmed.");
        const before = call.mutations.length; await call.mark(); await call.say("What happened?"); assert.equal(call.mutations.length, before);
        await call.scan(verificationCanaries);
      }, { classes: true });
    });
});
