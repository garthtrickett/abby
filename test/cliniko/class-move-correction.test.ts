import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { classAttendee, classLink } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";

async function fixture(different = false, nextDay = false) {
  const f = await classMoveCallFlowFixture(different);
  f.native.groups.push({ ...structuredClone(f.native.groups[1]!), id: "95", ...classLink("group_appointments", "95"),
    starts_at: nextDay ? "2026-10-10T10:00:00.000Z" : "2026-10-09T12:00:00.000Z",
    ends_at: nextDay ? different ? "2026-10-10T10:30:00.000Z" : "2026-10-10T11:00:00.000Z" : different ? "2026-10-09T12:30:00.000Z" : "2026-10-09T13:00:00.000Z" });
  resultValue(await f.flow.startWorkflow({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
    operation: "reschedule", classAttendance: true, signal: new AbortController().signal }));
  await f.play(); for (let i = 0; i < 100 && !f.mail.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.mail.length, 1); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
  const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, f.classSessionConfig.clock);
  const first = await f.prepare(reception);
  return { ...f, reception, first };
}

for (const different of [false, true]) for (const correction of ["ordinal", "date"] as const)
  test(`E2E-401 class move ${correction} correction ${different ? "across services" : "between occurrences"} cancels old consent and writes only the newly selected occurrence after a valid pause`, async () => {
    const f = await fixture(different, correction === "date");
    try {
      const turn = f.turn("correction", correction === "ordinal" ? "No, the second time please" : "Move it to October 10");
      resultValue(await f.runtime.nonAffirmativeFinal(turn, (await f.state()).conversationRevision, verificationNow));
      assert.equal((await f.state()).actions[f.first.key]!.status, "canceled");
      if (correction === "ordinal") {
        const intent = await f.flow.correctionIntent(turn);
        assert.equal(intent?.kind, "reschedule"); if (intent?.kind !== "reschedule") throw new Error("missing correction");
        resultValue(await f.reception.proposeAppointmentChange(f.scope, turn, intent, verificationNow));
      } else {
        resultValue(await f.reception.readReschedulingMenu(f.scope, turn, "offers", "2026-10-10", "2026-10-10", verificationNow, true));
        await f.play(); resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("new-offer", "one"), "offers", 1, verificationNow));
      }
      const corrected = Object.values((await f.state()).actions).at(-1)!;
      assert.notEqual(corrected.key, f.first.key); assert.equal(corrected.status, "awaitingConfirmation");
      assert.equal(corrected.mutation.request.kind, "reschedule"); if (corrected.mutation.request.kind !== "reschedule") throw new Error("missing move");
      assert.equal(corrected.mutation.request.offer.startsAt, correction === "date" ? "2026-10-10T10:00:00.000Z" : "2026-10-09T12:00:00.000Z");
      assert.equal(corrected.mutation.request.offer.presentation?.durationMinutes, different ? 30 : 60);
      assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
      await f.pause(61); await f.play(); const now = f.classSessionConfig.clock();
      resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), corrected.key, corrected.digest, now));
      resultValue(await f.reception.drain(f.scope, f.callId, now));
      assert.equal((await f.state()).actions[corrected.key]!.status, "committed", JSON.stringify({ claims: f.claims, windows: f.windowClaims, last: (await f.state()).callerMessages.at(-1) }));
      assert.equal((await f.state()).actions[f.first.key]!.status, "canceled");
      assert.equal(f.writes[0]!.body.booking_id, "95"); assert.deepEqual(f.writes.map(row => row.path), ["/v1/attendees", "/v1/attendees/101/cancel"]);
      assert.ok(f.windowClaims.every(count => count <= 180));
    } finally { await f.close(); }
  });

for (const fault of ["permission", "approval", "expired", "foreignTarget", "full", "originalCancelled"] as const)
  test(`E2E-401 ${fault} cannot turn cancelled class consent into a corrected native move`, async () => {
    const f = await fixture();
    try {
      const turn = f.turn("correction", "No, the second time please");
      resultValue(await f.runtime.nonAffirmativeFinal(turn, (await f.state()).conversationRevision, verificationNow));
      if (fault === "permission") f.permit(false);
      if (fault === "approval") await f.replaceMove({ enabled: false });
      if (fault === "expired") await f.pause(121);
      if (fault === "full") for (let i = 0; i < 3; i++) f.native.attendees.push(classAttendee(String(701 + i), "95", String(801 + i)));
      if (fault === "originalCancelled") f.native.attendees.find(row => row.id === "101")!.cancelled_at = verificationNow;
      if (fault === "foreignTarget") {
        const denied = await f.flow.readReschedulingMenu({ scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.flowConfig.policyVersion,
          turnId: turn.turnId, now: f.classSessionConfig.clock(), signal: new AbortController().signal, stage: "offers", from: "2026-10-09", to: "2026-10-09", correctingAppointmentRef: "other-target" });
        assert.equal(denied.ok, false);
      } else {
        const intent = await f.flow.correctionIntent({ ...turn, at: f.classSessionConfig.clock() });
        if (fault === "full" || fault === "originalCancelled") {
          assert.equal(intent?.kind, "reschedule"); if (intent?.kind !== "reschedule") throw new Error("missing private selection");
          resultValue(await f.reception.proposeAppointmentChange(f.scope, turn, intent, verificationNow));
        } else assert.equal(intent?.kind, "clarify");
      }
      assert.deepEqual([f.writes.length, f.recalls.length], [0, 0]);
      assert.equal(Object.keys((await f.state()).actions).length, 1); assert.equal((await f.state()).actions[f.first.key]!.status, "canceled");
    } finally { await f.close(); }
  });

test("E2E-401 a committed class move cannot be corrected by replaying the earlier class menu", async () => {
  const f = await fixture();
  try {
    await f.play(); resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), f.first.key, f.first.digest, verificationNow));
    resultValue(await f.reception.drain(f.scope, f.callId, verificationNow)); assert.equal((await f.state()).actions[f.first.key]!.status, "committed");
    assert.equal(await f.flow.correctionIntent(f.turn("late-correction", "No, the second time please")), undefined);
    assert.equal(f.writes.length, 2); assert.equal(f.recalls.length, 1);
  } finally { await f.close(); }
});
