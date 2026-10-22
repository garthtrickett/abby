// E2E-425: independently verified native callback context and exact original ownership.
import assert from "node:assert/strict";
import test from "node:test";
import { incomingClinicalCallFlowFixture } from "../support/incoming-clinical-call-flow.ts";
import { value } from "../support/outbound-records.ts";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";

type Fixture = Awaited<ReturnType<typeof incomingClinicalCallFlowFixture>>;
async function prepare(f: Fixture, stage: (name: string) => void = () => {}) {
  await f.verify(); stage("read-verified");
  const reason = value(await f.reception.respondMissedCall(f.scope, f.turn("Why did the clinic call me?")));
  assert.equal(reason.callerMessages.at(-1), "The clinic called about rescheduling your appointment. I can help with that, or you can contact reception.");
  assert.equal(f.mail.length, 1); stage("reason-shown");
  await f.verify("reschedule"); assert.equal(f.mail.length, 2); stage("move-verified");
  const targets = value(await f.reception.readReschedulingMenu(f.scope, f.turn("Which appointment can I move?"), "targets",
    f.now, "2026-11-03T10:05:00.000Z", f.now));
  assert.match(targets.callerMessages.at(-1)!, /Which appointment would you like to move\?.*Option one/);
  assert.doesNotMatch(targets.callerMessages.at(-1)!, /Option two/); stage("target-shown");
  await f.play(); value(await f.reception.selectReschedulingMenu(f.scope, f.turn("The first appointment"), "targets", 1, f.now));
  await f.play(); stage("target-selected");
  const offers = value(await f.reception.readReschedulingMenu(f.scope, f.turn("What times on Tuesday?"), "offers", "2026-11-03", "2026-11-03", f.now));
  assert.match(offers.callerMessages.at(-1)!, /option one/i); stage("offers-shown");
  await f.play(); value(await f.reception.selectReschedulingMenu(f.scope, f.turn("The first time"), "offers", 1, f.now));
  const action = Object.values((await f.callState()).actions).at(-1)!; assert.ok(action);
  assert.equal(action.mutation.request.kind, "reschedule");
  if (action.mutation.request.kind !== "reschedule") assert.fail();
  assert.equal(action.mutation.request.target.appointmentRef, "71");
  assert.equal(action.mutation.request.offer.startsAt, f.moveStarts[0]);
  assert.equal(f.writes.length, 0); stage("proposal-made"); return action;
}
async function confirm(f: Fixture, action: Awaited<ReturnType<typeof prepare>>) {
  await f.play(); value(await f.reception.affirm(f.scope, f.turn("Yes, move it"), action.key, action.digest, f.now));
  value(await f.reception.drain(f.scope, f.callId, f.now));
}

for (const snapshot of ["populated", "empty"] as const) {
  test(`verified incoming original ${snapshot} snapshot rescheduling moves only the campaign appointment after fresh code and played consent`, async t => {
    const f = await incomingClinicalCallFlowFixture({ snapshot, rescheduling: true }); t.after(f.close);
    const stages: { phase: string; requests: number }[] = [];
    const stage = (phase: string) => stages.push({ phase, requests: f.traffic.length });
    t.after(() => t.diagnostic(JSON.stringify({ stages })));
    const action = await prepare(f, stage);
    await f.play(); stage("consent-played");
    value(await f.reception.affirm(f.scope, f.turn("Yes, move it"), action.key, action.digest, f.now)); stage("affirmed");
    value(await f.reception.drain(f.scope, f.callId, f.now)); stage("drained");
    assert.deepEqual(f.moves, [{ id: "71", startsAt: f.moveStarts[0] }]); assert.deepEqual(f.writes, ["71"]);
    assert.equal(f.reviews.length, 1); assert.equal(f.earlier.starts_at, "2026-11-02T09:00:00.000001+11:00");
    assert.equal(Object.values((await f.callState()).actions).at(-1)!.status, "committed");
    value(await f.reception.drain(f.scope, f.callId, f.now)); assert.deepEqual(f.writes, ["71"]);
  });
}


test("the complete verified incoming original rescheduling fits the same physical180 native minute", async t => {
  const f = await incomingClinicalCallFlowFixture({ rescheduling: true, physical: true }); t.after(f.close);
  const stages: { phase: string; requests: number; accepted: number; denied: number }[] = [];
  const stage = (phase: string) => stages.push({ phase, requests: f.traffic.length, accepted: f.accepted - f.seedAccepted, denied: f.denied });
  t.after(() => { stage("terminal"); t.diagnostic(JSON.stringify({ physicalLimit: 180, seedRequests: f.seedAccepted, stages })); });
  const action = await prepare(f, stage); await confirm(f, action);
  assert.deepEqual(f.moves, [{ id: "71", startsAt: f.moveStarts[0] }]);
  assert.equal(Object.values((await f.callState()).actions).at(-1)!.status, "committed");
  assert.equal(f.denied, 0); assert.ok(f.accepted <= 180); assert.equal(f.accepted - f.seedAccepted, f.traffic.length);
});

for (const changed of ["native-microsecond", "cancelled-target", "original-request", "native-grant", "patient-permission", "patient-contact"] as const) {
  test(`changed ${changed} after the incoming move proposal cannot redirect or send its rescheduling`, async t => {
    const f = await incomingClinicalCallFlowFixture({ rescheduling: true }); t.after(f.close); const action = await prepare(f);
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
    if (changed === "patient-contact") f.setEmail("changed-native-contact@example.test");
    await confirm(f, action); assert.deepEqual(f.writes, []); assert.deepEqual(f.moves, []);
    assert.equal(f.earlier.starts_at, "2026-11-02T09:00:00.000001+11:00");
    assert.notEqual(Object.values((await f.callState()).actions).at(-1)!.status, "committed");
  });
}

test("a competing native actor can spend the incoming move's minute without authorizing its write", async t => {
  const f = await incomingClinicalCallFlowFixture({ rescheduling: true, physical: true }); t.after(f.close); const action = await prepare(f);
  while (f.physical.claim() === null) { /* Independent actor, same unchanged physical API-user minute. */ }
  await confirm(f, action); assert.deepEqual(f.moves, []); assert.deepEqual(f.writes, []); assert.ok(f.accepted <= 180);
  assert.notEqual(Object.values((await f.callState()).actions).at(-1)!.status, "committed");
});

test("lost incoming move acknowledgement stays uncertain and never sends a second mutation", async t => {
  const f = await incomingClinicalCallFlowFixture({ rescheduling: true, lostWrite: true }); t.after(f.close); const action = await prepare(f);
  await confirm(f, action); assert.deepEqual(f.moves, [{ id: "71", startsAt: f.moveStarts[0] }]); assert.equal(f.reviews.length, 1);
  assert.equal(Object.values((await f.callState()).actions).at(-1)!.status, "uncertain");
  value(await f.reception.drain(f.scope, f.callId, f.now)); assert.deepEqual(f.writes, ["71"]);
});

test("a populated incoming move snapshot contradicting the campaign target cannot select the earlier appointment", async t => {
  const f = await incomingClinicalCallFlowFixture({ rescheduling: true, snapshot: "conflicting" }); t.after(f.close);
  await f.verify(); value(await f.reception.respondMissedCall(f.scope, f.turn("Why did the clinic call me?")));
  await f.verify("reschedule");
  const result = value(await f.reception.readReschedulingMenu(f.scope, f.turn("Which appointment can I move?"), "targets", f.now, "2026-11-03T10:05:00.000Z", f.now));
  assert.equal(Object.keys(result.actions).length, 0); assert.deepEqual(f.writes, []); assert.equal(f.reviews.length, 0);
  assert.doesNotMatch(result.callerMessages.at(-1)!, /Option one/);
});
