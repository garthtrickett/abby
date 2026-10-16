import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow, verificationCanaries } from "../support/caller-verification.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { appointmentChangeEvidenceFailure } from "../../src/core/transition.ts";
import { classAttendee } from "../support/class-attendance.ts";

for (const different of [false, true])
  test(`E2E-398 actual SAM class movement ${different ? "to a different instructor/type/duration after a caller pause" : "between occurrences"} requires private proof and played target/offer/recovery consent`, async () => {
    const f = await classMoveFixture(different);
    try {
      const before = await f.state(); assert.equal(before.policy.bookingEnabled, false); assert.equal(before.policy.cancellationEnabled, false);
      await f.verify(); const action = await f.prepare();
      const presentation = (await f.state()).presentations[action.presentationId]!;
      assert.match("approvedText" in presentation ? presentation.approvedText : "", /book the replacement before cancelling the original/);
      assert.match("approvedText" in presentation ? presentation.approvedText : "", /No move fee applies/);
      if (different) assert.match("approvedText" in presentation ? presentation.approvedText : "", /moving your Mat Pilates.*to Reformer Pilates.*Second Instructor.*30 minutes/);
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
      if (different) await f.pause(61);
      const at = different ? "2026-10-04T06:01:01.000Z" : verificationNow;
      await f.play(); resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, at));
      resultValue(await f.reception.drain(f.scope, f.callId, at));
      const final = await f.state();
      assert.equal(final.actions[action.key]!.status, "committed", JSON.stringify({ claims: f.claims, steps: f.steps, writes: f.writes.map(row => row.path), nativeReads: f.native.traffic.length, patientReads: f.provider.length, last: final.callerMessages.at(-1) }));
      assert.equal(f.writes.length, 2); assert.deepEqual(f.writes.map(row => row.path), ["/v1/attendees", "/v1/attendees/101/cancel"]);
      assert.equal(f.writes[0]!.body.booking_id, "94"); assert.equal(f.recalls.length, 1);
      assert.equal(resultValue(decodeClinikoReview(f.recalls[0]!.notes)).request.operation.kind, "classMove");
      assert.ok(f.windowClaims.every(count => count <= 180), `physical claims by request window: ${f.windowClaims}`);
      assert.equal(f.windowClaims.length, different ? 2 : 1);
      assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, at);
      assert.equal(f.native.attendees.find(row => row.id === "401")!.cancelled_at, null);
      for (const canary of verificationCanaries) assert.equal(JSON.stringify(final.callerMessages).includes(canary), false);
    } finally { await f.close(); }
  });

test("E2E-398 known insufficient cross-service budget waits before review or attendance mutation", async () => {
  const f = await classMoveFixture(true);
  try {
    await f.verify(); const action = await f.prepare(); await f.play();
    resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, verificationNow));
    resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
    assert.equal((await f.state()).actions[action.key]!.status, "awaitingConfirmation");
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
  } finally { await f.close(); }
});

test("E2E-398 destination notice crossed during an otherwise valid caller pause cannot start movement", async () => {
  const f = await classMoveFixture(false, true);
  try {
    await f.verify(); const action = await f.prepare(); await f.pause(61); await f.play();
    resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, "2026-10-04T06:01:01.000Z"));
    resultValue(await f.reception.drain(f.scope, f.callId, "2026-10-04T06:01:01.000Z"));
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    assert.equal((await f.state()).actions[action.key]!.status, "canceled");
  } finally { await f.close(); }
});

for (const fault of ["patientPermission", "movePermission", "sourceApproval", "destinationApproval", "moveApproval", "actor", "stop", "ended", "unplayed"] as const)
  test(`E2E-398 ${fault} after preparation cannot send class movement or claim success`, async () => {
    const f = await classMoveFixture();
    try {
      await f.verify(); const action = await f.prepare();
      if (fault === "patientPermission") f.setPermitted(false);
      if (fault === "movePermission") f.permit(false);
      if (fault === "sourceApproval") await f.replaceSource({ enabled: false });
      if (fault === "destinationApproval") await f.replaceDestination({ enabled: false });
      if (fault === "moveApproval") await f.replaceMove({ revision: "changed" });
      if (fault === "actor") await f.replaceAccount({ membershipVersion: "changed" });
      if (fault === "stop") resultValue(await f.ledger.stopWrites(f.scope, "synthetic-admin", "stop"));
      if (fault === "ended") resultValue(await f.runtime.endCall(f.callId, f.sessionId, verificationNow));
      if (fault !== "unplayed" && fault !== "ended") await f.play();
      await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, verificationNow);
      await f.reception.drain(f.scope, f.callId, verificationNow);
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
      assert.notEqual((await f.state()).actions[action.key]!.status, "committed");
    } finally { await f.close(); }
  });

for (const lost of ["review", "replacement", "original", "compensation"] as const)
  test(`E2E-398 lost ${lost} response remains unresolved through actual SAM and never replays`, async () => {
    const f = await classMoveFixture();
    try {
      await f.verify(); const action = await f.prepare(); f.lose(lost);
      if (lost === "compensation") f.phasePermission(phase => phase !== "cancelOriginal");
      await f.play(); resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, verificationNow));
      resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
      assert.equal((await f.state()).actions[action.key]!.status, "uncertain");
      const writes = f.writes.length; assert.equal(writes, lost === "review" ? 0 : lost === "replacement" ? 1 : 2);
      resultValue(await f.reception.drain(f.scope, f.callId, verificationNow)); assert.equal(f.writes.length, writes);
      assert.deepEqual(await f.host.reconcile(action.mutation), { kind: "stillUnknown", actionKey: action.key });
      assert.equal(f.recalls.length, 1);
    } finally { await f.close(); }
  });

test("E2E-398 an unsent original cancellation can restore the original without reporting a completed move", async () => {
  const f = await classMoveFixture();
  try {
    await f.verify(); const action = await f.prepare(); f.phasePermission(phase => phase !== "cancelOriginal");
    await f.play(); resultValue(await f.reception.affirm(f.scope, f.turn("yes", "Yes"), action.key, action.digest, verificationNow));
    resultValue(await f.reception.drain(f.scope, f.callId, verificationNow));
    assert.equal((await f.state()).actions[action.key]!.status, "rejected");
    assert.deepEqual(f.writes.map(row => row.path), ["/v1/attendees", "/v1/attendees/401/cancel"]);
    assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
    assert.equal(f.native.attendees.find(row => row.id === "401")!.cancelled_at, verificationNow);
  } finally { await f.close(); }
});

test("E2E-398 unplayed target menus cannot choose an original or disclose replacement options", async () => {
  const f = await classMoveFixture();
  try {
    await f.verify();
    resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("targets"), "targets", "2026-10-08", "2026-10-08", verificationNow));
    const result = await f.reception.selectReschedulingMenu(f.scope, f.turn("choice", "one"), "targets", 1, verificationNow);
    assert.ok(!result.ok || !result.value.callerMessages.at(-1)?.includes("You've selected"));
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0); assert.equal(Object.keys((await f.state()).actions).length, 0);
  } finally { await f.close(); }
});

test("E2E-398 duration/service replacement requires explicit bound presentation and legacy duration guards remain intact", async () => {
  const f = await classMoveFixture(true);
  try {
    await f.verify(); const action = await f.prepare(), request = action.mutation.request;
    assert.equal(request.kind, "reschedule"); if (request.kind !== "reschedule") throw new Error("missing movement");
    assert.deepEqual(request.serviceChange, { fromServiceName: "Mat Pilates" }); assert.equal(appointmentChangeEvidenceFailure(f.scope, request, verificationNow), undefined);
    const { serviceChange, ...legacy } = request;
    assert.equal(appointmentChangeEvidenceFailure(f.scope, legacy, verificationNow)?.kind, "invalidTransition");
    assert.equal(appointmentChangeEvidenceFailure(f.scope, { ...request, serviceChange: false } as unknown as typeof request, verificationNow)?.kind, "invalidTransition");
    const { presentation, ...withoutPresentation } = request.offer;
    assert.equal(appointmentChangeEvidenceFailure(f.scope, { ...request, offer: withoutPresentation }, verificationNow)?.kind, "invalidTransition");
  } finally { await f.close(); }
});

for (const drift of ["full", "originalCancelled", "duplicateDestination", "movePermission"] as const)
  test(`E2E-398 ${drift} after candidate playback fails strict native proposal before consent or writes`, async () => {
    const f = await classMoveFixture();
    try {
      await f.verify();
      resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("targets"), "targets", "2026-10-08", "2026-10-08", verificationNow)); await f.play();
      resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("target", "one"), "targets", 1, verificationNow)); await f.play();
      resultValue(await f.reception.readReschedulingMenu(f.scope, f.turn("offers"), "offers", "2026-10-09", "2026-10-09", verificationNow)); await f.play();
      if (drift === "full") for (const index of [1, 2, 3]) f.native.attendees.push(classAttendee(String(800 + index), "94", String(900 + index)));
      if (drift === "originalCancelled") f.native.attendees.find(row => row.id === "101")!.cancelled_at = verificationNow;
      if (drift === "duplicateDestination") for (const index of [1, 2]) f.native.attendees.push(classAttendee(String(800 + index), "94", verificationCanaries[2]!));
      if (drift === "movePermission") f.native.onRead((path, count) => { if (path === "/v1/group_appointments/91" && count === 2) f.permit(false); });
      resultValue(await f.reception.selectReschedulingMenu(f.scope, f.turn("offer", "one"), "offers", 1, verificationNow));
      assert.equal(Object.keys((await f.state()).actions).length, 0); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
    } finally { await f.close(); }
  });
