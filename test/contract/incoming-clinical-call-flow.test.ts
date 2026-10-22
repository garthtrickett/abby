import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { incomingClinicalCallFlowFixture } from "../support/incoming-clinical-call-flow.ts";
import { value } from "../support/outbound-records.ts";

type Fixture = Awaited<ReturnType<typeof incomingClinicalCallFlowFixture>>;
async function prepare(f: Fixture, stage: (name: string) => void = () => {}) {
  await f.verify(); stage("read-verified");
  const reason = value(await f.reception.respondMissedCall(f.scope, f.turn("Why did the clinic call me?")));
  assert.equal(reason.callerMessages.at(-1), "The clinic called about rescheduling your appointment. I can help with that, or you can contact reception.");
  stage("reason-shown"); assert.equal(f.mail.length, 1); assert.equal(f.writes.length, 0);
  await f.verify("cancel"); stage("cancel-verified"); assert.equal(f.mail.length, 2);
  const proof = await f.flow.cancellationProof(); assert.ok(proof);
  value(await f.reception.checkAppointments(f.scope, f.turn("Read the appointment to cancel"), proof.verificationRef,
    f.now, "2026-11-03T10:05:00.000Z", f.now));
  assert.equal((await f.callState()).appointmentReads.at(-1)?.status, "shown");
  assert.equal((await f.callState()).appointmentReads.at(-1)?.shownCount, 1); stage("target-shown");
  assert.doesNotMatch((await f.callState()).callerMessages.at(-1)!, /Option two/);
  await f.play();
  value(await f.reception.proposeAppointmentChange(f.scope, f.turn("Cancel that appointment"),
    { kind: "cancel", verificationRef: proof.verificationRef, targetRef: "selected" }, f.now));
  const action = Object.values((await f.callState()).actions).at(-1)!; assert.ok(action);
  assert.equal(action.mutation.request.kind, "cancel");
  if (action.mutation.request.kind !== "cancel") assert.fail();
  assert.equal(action.mutation.request.target.appointmentRef, "71"); assert.equal(f.writes.length, 0);
  stage("proposal-made"); return action;
}
async function confirm(f: Fixture, action: Awaited<ReturnType<typeof prepare>>) {
  await f.play(); value(await f.reception.affirm(f.scope, f.turn("Yes"), action.key, action.digest, f.now));
  value(await f.reception.drain(f.scope, f.callId, f.now));
}

for (const snapshot of ["populated", "empty"] as const) {
  test(`verified incoming sick-day ${snapshot} snapshot cancels only the original target after fresh operation code and played consent`, async t => {
    const f = await incomingClinicalCallFlowFixture({ snapshot }); t.after(f.close);
    const action = await prepare(f);
    await confirm(f, action);
    assert.deepEqual(f.writes, ["71"]); assert.equal(f.reviews.length, 1); assert.equal(f.earlier.cancelled_at, null);
    assert.equal(Object.values((await f.callState()).actions).at(-1)!.status, "committed");
    value(await f.reception.drain(f.scope, f.callId, f.now)); assert.deepEqual(f.writes, ["71"]);
  });
}


test("the complete verified incoming original cancellation fits the same physical180 native minute", async t => {
  const f = await incomingClinicalCallFlowFixture({ physical: true }); t.after(f.close);
  const stages: { phase: string; requests: number; accepted: number; denied: number }[] = [];
  const stage = (phase: string) => stages.push({ phase, requests: f.traffic.length, accepted: f.accepted - f.seedAccepted, denied: f.denied });
  t.after(() => { stage("terminal"); t.diagnostic(JSON.stringify({ physicalLimit: 180, seedRequests: f.seedAccepted, stages })); });
  const action = await prepare(f, stage); await confirm(f, action);
  assert.deepEqual(f.writes, ["71"]); assert.equal(f.denied, 0); assert.ok(f.accepted <= 180);
  assert.equal(f.accepted - f.seedAccepted, f.traffic.length);
});


test("an unanswered sick-day original reaches the same independently verified exact clinical target", async t => {
  const f = await incomingClinicalCallFlowFixture({ unanswered: true, physical: true }); t.after(f.close);
  const action = await prepare(f); await confirm(f, action);
  assert.deepEqual(f.writes, ["71"]); assert.equal(f.denied, 0); assert.ok(f.accepted <= 180);
  assert.equal(f.accepted - f.seedAccepted, f.traffic.length);
});

test("a populated snapshot contradicting the campaign target cannot select the earlier appointment", async t => {
  const f = await incomingClinicalCallFlowFixture({ snapshot: "conflicting" }); t.after(f.close);
  await f.verify(); value(await f.reception.respondMissedCall(f.scope, f.turn("Why did the clinic call me?")));
  await f.verify("cancel"); const proof = await f.flow.cancellationProof(); assert.ok(proof);
  const result = value(await f.reception.checkAppointments(f.scope, f.turn("Read the appointment"), proof.verificationRef,
    f.now, "2026-11-03T10:05:00.000Z", f.now));
  assert.equal(result.appointmentReads.at(-1)?.status, "failed"); assert.equal(Object.keys(result.actions).length, 0);
  assert.deepEqual(f.writes, []); assert.equal(f.reviews.length, 0);
});

for (const changed of ["native-microsecond", "cancelled-target", "original-request", "native-grant", "patient-permission"] as const) {
  test(`changed ${changed} after the incoming proposal cannot redirect or send its cancellation`, async t => {
    const f = await incomingClinicalCallFlowFixture(); t.after(f.close); const action = await prepare(f);
    if (changed === "native-microsecond") {
      const before = String(f.target.row.updated_at); f.target.row.updated_at = before.replace("000001", "000002");
      assert.notEqual(f.target.row.updated_at, before); assert.equal(Date.parse(String(f.target.row.updated_at)), Date.parse(before));
    }
    if (changed === "cancelled-target") f.target.row.cancelled_at = f.now;
    if (changed === "original-request") {
      f.native.rows.get("30")!.notes = value(encodeOutboundRecipientRequest({ ...f.native.request, policy: { ...f.native.request.policy, version: "changed-original-policy" } }));
      f.native.rows.get("30")!.updated_at = f.now;
    }
    if (changed === "native-grant") f.state.live = false;
    if (changed === "patient-permission") f.setPermitted(false);
    await confirm(f, action);
    assert.deepEqual(f.writes, []); assert.equal(f.earlier.cancelled_at, null);
    assert.notEqual(Object.values((await f.callState()).actions).at(-1)!.status, "committed");
  });
}

test("a competing native actor can consume the same minute after the incoming proposal without authorizing a write", async t => {
  const f = await incomingClinicalCallFlowFixture({ physical: true }); t.after(f.close); const action = await prepare(f);
  while (f.physical.claim() === null) { /* Another actor spends the same fixed API-user minute. */ }
  await confirm(f, action); assert.deepEqual(f.writes, []); assert.ok(f.accepted <= 180);
  assert.notEqual(Object.values((await f.callState()).actions).at(-1)!.status, "committed");
});

test("lost incoming original cancellation acknowledgement stays uncertain and never sends a second mutation", async t => {
  const f = await incomingClinicalCallFlowFixture({ lostWrite: true }); t.after(f.close); const action = await prepare(f);
  await confirm(f, action); assert.deepEqual(f.writes, ["71"]); assert.equal(f.reviews.length, 1);
  assert.equal(Object.values((await f.callState()).actions).at(-1)!.status, "uncertain");
  value(await f.reception.drain(f.scope, f.callId, f.now)); assert.deepEqual(f.writes, ["71"]);
});
