import assert from "node:assert/strict";
import test from "node:test";
import { decodeTwilioOutboundUnansweredObservation, twilioOutboundUnansweredActionRef } from "../../src/cliniko/twilio-outbound-unanswered-observation.ts";
import { twilioOutboundUnansweredProducerFixture as fixture } from "../support/twilio-outbound-unanswered-producer.ts";
import { value } from "../support/outbound-records.ts";
import { twilioUnansweredObservationProfileBinding, TwilioOutboundUnansweredObservationProducer } from "../../src/standalone/twilio-outbound-unanswered-observation.ts";

test("actual signed no-answer notification retains one dedicated native observation without contact or release evidence", async () => {
  const f = await fixture(), request = f.request(), decoded = value(f.runtime.authenticateStatus(request)), context = decoded.call.context;
  const retained = value(await f.producer.observeStatus(request, new AbortController().signal)); assert.equal(retained.kind, "accepted");
  if (retained.kind !== "accepted") assert.fail();
  const row = f.native.rows.get(retained.recallRef.split(":").at(-1)!)!, observation = value(decodeTwilioOutboundUnansweredObservation(row.notes));
  assert.equal(f.auth.matchesOriginal(observation, context, f.config.accountSid), true);
  assert.equal(observation.actionRef, twilioOutboundUnansweredActionRef(context.sessionActionRef));
  assert.equal(observation.receivedAt, decoded.call.receivedAt); assert.equal(observation.recordedAt, "2026-11-01T10:03:00.000Z");
  assert.deepEqual([...f.burned.keys()], [observation.actionRef]);
  for (const ref of [context.reportActionRef, context.sessionActionRef, context.original.attempt.actionRef]) assert.equal(f.burned.has(ref), false);
  for (const key of ["endedAt", "complete", "contact", "transcript", "patientVerified"]) assert.equal(Object.hasOwn(observation, key), false);
  assert.equal((await f.producer.observeStatus(request, new AbortController().signal)).ok, false);
  assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1); assert.equal(f.native.claims, 1); assert.equal(f.carrierRequests, 1);
});

for (const patch of [{ AccountSid: "AC" + "9".repeat(32) }, { To: "+12025550999" }, { From: "+61255550999" }, { Direction: "inbound" }])
test(`even signed foreign status ${Object.keys(patch).join()} cannot retain a native observation`, async () => {
  const f = await fixture(); assert.equal((await f.producer.observeStatus(f.request(patch), new AbortController().signal)).ok, false);
  assert.equal(f.native.calls.length, 0); assert.equal(f.native.claims, 0); assert.equal(f.burned.size, 0);
});

test("a decoded event or changed signature/body cannot substitute for raw request reauthentication", async () => {
  const f = await fixture(), request = f.request();
  for (const changed of [{ ...request, signature: "forged" }, { ...request, body: request.body + "&To=%2B12025550999" }])
    assert.equal((await f.producer.observeStatus(changed, new AbortController().signal)).ok, false);
  assert.equal(f.burned.size, 0); assert.equal(f.native.calls.length, 0);
});

test("all unsupported authentic progress/unanswered statuses stay free of this no-answer-notification effect", async () => {
  const f = await fixture();
  for (const CallStatus of ["queued", "initiated", "ringing", "in-progress", "busy", "failed", "completed", "canceled"])
    assert.deepEqual(value(await f.producer.observeStatus(f.request({ CallStatus }), new AbortController().signal)), { kind: "ignoredStatus" });
  assert.equal(f.burned.size, 0); assert.equal(f.native.claims, 0); assert.equal(f.native.calls.length, 0);
});

test("a genuine legacy original profile never acquires unanswered notification write authority", async () => {
  const f = await fixture({ legacy: true });
  assert.equal((await f.producer.observeStatus(f.request(), new AbortController().signal)).ok, false);
  assert.equal(f.burned.size, 0); assert.equal(f.native.claims, 0); assert.equal(f.native.calls.length, 0);
});

for (const grant of ["source", "record", "producer", "current"] as const)
test(`actual notification needs independent current ${grant} grant`, async () => {
  const f = await fixture(); f.state[grant] = false;
  assert.equal((await f.producer.observeStatus(f.request(), new AbortController().signal)).ok, false);
  assert.equal(f.burned.size, 0); assert.equal(f.native.calls.length, 0);
});

test("source withdrawal after its actual asynchronous read prevents the effect claim", async () => {
  const f = await fixture(); f.state.beforeSource = () => { f.state.source = false; };
  assert.equal((await f.producer.observeStatus(f.request(), new AbortController().signal)).ok, false);
  assert.equal(f.burned.size, 0); assert.equal(f.native.calls.length, 0);
});

test("source withdrawal during the physical budget wait fences native dispatch after permanently spending the action", async () => {
  const f = await fixture(); f.state.beforeBudget = () => { f.state.source = false; };
  assert.equal((await f.producer.observeStatus(f.request(), new AbortController().signal)).ok, false);
  assert.equal(f.burned.size, 1); assert.equal(f.native.claims, 1); assert.equal(f.native.calls.length, 0);
});

test("lost native acknowledgement and later signed duplicate consume the same purpose without a new local private map", async () => {
  const f = await fixture({ response: () => { throw Error("synthetic stored acknowledgement lost"); } }), request = f.request();
  assert.equal(value(await f.producer.observeStatus(request, new AbortController().signal)).kind, "uncertain");
  f.native.setNow("2026-11-01T10:04:00.000Z");
  assert.equal((await f.producer.observeStatus(request, new AbortController().signal)).ok, false);
  assert.equal(f.native.rows.size, 1); assert.equal(f.native.calls.filter(c => c.method === "POST").length, 1); assert.equal(f.burned.size, 1);
});

test("captured key and method selections cannot be replaced to bypass current native grants", async () => {
  const f = await fixture(); f.key.fill(0); f.record.current = () => true; f.state.current = false;
  assert.equal((await f.producer.observeStatus(f.request(), new AbortController().signal)).ok, false);
  assert.equal(f.native.calls.length, 0); assert.equal(f.burned.size, 0);
});

test("a bounded ignored source read cannot dispatch after its owner has returned", async () => {
  const f = await fixture({ deadlineMs: 50 }); let release!: () => void;
  const held = new Promise<void>(r => { release = r; }); f.state.beforeSource = () => held;
  assert.equal((await f.producer.observeStatus(f.request(), new AbortController().signal)).ok, false);
  release(); await new Promise<void>(r => setImmediate(r)); assert.equal(f.native.calls.length, 0); assert.equal(f.burned.size, 0);
});


test("native family, policy, key and actual deadline stay bound to explicit original profile selection", async () => {
  const f = await fixture(), selected = f.producer.profileBinding();
  assert.equal(twilioUnansweredObservationProfileBinding(f.observations, f.key), selected);
  for (const observations of [{ ...f.observations, deadlineMs: 5000 }, { ...f.observations, outboundUnansweredObservationRecallTypeId: "67" },
    { ...f.observations, unansweredObservationPolicyDigest: "b".repeat(64) }]) {
    assert.notEqual(twilioUnansweredObservationProfileBinding(observations, f.key), selected);
    const changed = value(TwilioOutboundUnansweredObservationProducer.create({ runtime: f.runtime, observations, key: f.key }, f.ports));
    assert.equal((await changed.observeStatus(f.request(), new AbortController().signal)).ok, false);
  }
  assert.notEqual(twilioUnansweredObservationProfileBinding(f.observations, Buffer.alloc(32, 43)), selected);
  assert.equal(f.burned.size, 0); assert.equal(f.native.calls.length, 0);
});


test("unanswered-call selection cannot be inherited from the completed observation profile", async () => {
  const f = await fixture();
  const original = f.approval.unansweredCallObservationBinding;
  delete (f.approval as { unansweredCallObservationBinding?: string }).unansweredCallObservationBinding;
  Object.assign(f.approval, { terminalObservationBinding: original });
  assert.equal((await f.producer.observeStatus(f.request(), new AbortController().signal)).ok, false);
  assert.equal(f.burned.size, 0); assert.equal(f.native.calls.length, 0);
});
