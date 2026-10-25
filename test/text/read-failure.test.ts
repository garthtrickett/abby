import assert from "node:assert/strict";
import test from "node:test";
import type { TurnInterpretation } from "../../src/core/model.ts";
import { deadline, now, setup, success } from "./fixture.ts";

test("TXT-07 unavailable reads do not become definite no-match claims", async () => {
  const app = await setup("read-failure");
  await app.turn("patient-unavailable", "Find me", { kind: "readFailure", target: "patient", failure: "unavailable" });
  await app.turn("offer-unavailable", "Any appointments?", { kind: "readFailure", target: "offer", failure: "unavailable" });
  assert.deepEqual((await app.state()).callerMessages, ["I can't check patient records right now.", "I can't check available times right now."]);
  assert.equal(Object.values((await app.state()).staffItems).length, 2);
  assert.equal(Object.values((await app.state()).effects).some(effect => effect.kind === "hostWrite"), false);
  await app.turn("no-offers", "Try another day", { kind: "readFailure", target: "offer", failure: "notFound" });
  assert.equal((await app.state()).callerMessages.at(-1), "I couldn't find an eligible time.");
});

test("TXT-07 appointment failure explanations survive unavailable staff routes without becoming empty results", async () => {
  for (const [staffWorkEnabled, suffix] of [
    [true, "I'll request staff follow-up."],
    [false, "I can't send a staff request from this call. Please contact the clinic directly."],
  ] as const) {
    for (const [scenario, prefix] of [
      ["unavailable", "I can't check appointments right now."],
      ["invalidProof", "I can't verify whose appointment to check."],
      ["unclear", "I can't verify whose appointment to check."],
      ["invalidEvidence", "I can't check appointments right now."],
      ["empty", "I couldn't find an appointment in that time range."],
    ] as const) {
      const app = await setup(`appointment-failure-${staffWorkEnabled}-${scenario}`);
      const callId = `${app.callId}:read`;
      success(await app.runtime.start(callId, { ...app.policy, staffWorkEnabled }));
      const interpretation: TurnInterpretation = scenario === "empty" || scenario === "invalidEvidence"
        ? { kind: "appointments", from: now, to: deadline, snapshot: {
          scope: scenario === "invalidEvidence" ? { ...app.scope, locationId: "foreign" } : app.scope,
          sourceRef: "synthetic-appointment-read", observedAt: now, timeZone: "Australia/Sydney",
          patientRef: app.patient.patientRef, verificationRef: app.patient.verificationRef,
          proofExpiresAt: deadline, appointments: [],
        } } : { kind: "appointmentsFailure", reason: scenario };
      const state = success(await app.runtime.acceptTurn({ callId, turnId: "check", text: "Check my appointments", quality: "clear", at: now }, interpretation, now));
      assert.equal(state.callerMessages.at(-1), scenario === "empty" ? prefix : `${prefix} ${suffix}`);
      assert.equal(state.appointmentReads.at(-1)?.status, scenario === "empty" ? "empty" : "failed");
      assert.equal(Object.keys(state.staffItems).length, staffWorkEnabled && scenario !== "empty" ? 1 : 0);
      assert.deepEqual(state.actions, {});
      assert.equal(Object.values(state.effects).some(effect => effect.kind === "hostWrite"), false);
    }
  }
});
