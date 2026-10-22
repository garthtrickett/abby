// E2E-424: independently verified native callback context and exact original ownership.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import { encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { TwilioOutboundTerminalObservationAuthentication, encodeTwilioOutboundTerminalObservation } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { decodeTwilioOutboundUnansweredObservation, encodeTwilioOutboundUnansweredObservation } from "../../src/cliniko/twilio-outbound-unanswered-observation.ts";
import { twilioOutboundUnansweredProducerFixture } from "../support/twilio-outbound-unanswered-producer.ts";
import { incomingCallContextFixture } from "../support/incoming-call-context.ts";
import { value } from "../support/outbound-records.ts";

for (const sickDay of [false, true]) {
  test(`verified incoming native ${sickDay ? "exact sick-day" : "follow-up"} context uses authenticated original history only`, async t => {
    const f = await incomingCallContextFixture({ sickDay }); t.after(f.close);
    await f.verify(); const before = f.native.calls.length;
    const read = value(await f.read());
    assert.deepEqual(read, { scope: f.scope, callId: f.callId, sessionId: f.sessionId, policyVersion: f.sessionConfig.policyVersion,
      checkedAt: "2026-11-01T10:05:00.000Z", purpose: sickDay ? "sickDay" : "followUp" });
    assert.equal(f.lists, 2); assert.ok(f.queries.some(q => q.operation === "approveIncomingCallContext"));
    assert.ok(f.native.calls.slice(before).every(call => call.method === "GET"));
    for (const privateValue of [f.attempt.actionRef, f.attempt.effectRef, f.observation.callSid, "unrelated-private-history-note"])
      assert.equal(JSON.stringify(read).includes(privateValue), false);
    assert.equal(f.provider.includes("/v1/individual_appointments"), false, "general appointment lookup must not choose another target");
    if (sickDay) assert.ok(f.target.fetches >= 2);
  });
}

test("unverified incoming callers do not read native campaign history", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close);
  assert.equal((await f.read()).ok, false); assert.equal(f.lists, 0); assert.equal(f.queries.length, 0);
});

for (const fault of ["no-call", "tampered-authentication", "newer-possible", "too-old", "wrong-patient", "denied-history", "denied-purpose", "cancelled-target"] as const) {
  test(`incoming native context refuses ${fault} without manufacturing a prior call`, async t => {
    const f = await incomingCallContextFixture({ sickDay: fault === "cancelled-target", ...(fault === "wrong-patient" ? { patientId: "22" } : {}) }); t.after(f.close);
    if (fault === "no-call") f.native.rows.delete("50");
    if (fault === "tampered-authentication") {
      f.observationRow.notes = value(encodeTwilioOutboundTerminalObservation({ ...f.observation, authentication: "0".repeat(64) }));
    }
    if (fault === "newer-possible") {
      const a = { ...f.attempt, actionRef: randomUUID(), attemptedAt: "2026-11-01T10:02:00.000Z", dispatchNotAfter: "2026-11-01T10:03:00.000Z" };
      f.add("70", "62", value(encodeOutboundLaunchAttempt(a)), a.attemptedAt);
    }
    if (fault === "too-old") f.config.lookBackMs = 1;
    if (fault === "denied-history") f.state.allow = q => q.operation !== "readIncomingCallHistory";
    if (fault === "denied-purpose") f.state.allow = q => q.operation !== "approveIncomingCallContext";
    if (fault === "cancelled-target") f.target.row.cancelled_at = "2026-11-01T09:59:00.000Z";
    await f.verify();
    const context = fault === "too-old" ? value(f.make()) : f.context;
    assert.equal((await context.read(f.session, new AbortController().signal)).ok, false);
    if (fault === "denied-history") assert.equal(f.lists, 0);
    assert.ok(f.native.calls.slice(1).every(call => call.method === "GET"));
  });
}

test("a current disclosure grant withdrawn during the shared budget wait prevents the protected history GET", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); await f.verify();
  const claim = f.native.config.rateBudget.claim;
  let entered!: () => void, release!: () => void, held = false;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), freed = new Promise<void>(resolve => { release = resolve; });
  Object.assign(f.native.config.rateBudget, { claim: async () => {
    if (!held && f.queries.some(q => q.operation === "readIncomingCallHistory")) { held = true; entered(); await freed; }
    return claim();
  } });
  const pending = f.read(); await waiting;
  f.state.live = false; release();
  assert.equal((await pending).ok, false); assert.equal(f.lists, 0);
});

test("sick-day context keeps the exact appointment under fresh independent cancellation proof", async t => {
  const f = await incomingCallContextFixture({ sickDay: true }); t.after(f.close); await f.verify(); value(await f.read());
  assert.equal((await f.context.inspectAppointment(f.session, "appointments.cancel", new AbortController().signal)).ok, false,
    "read proof is not cancellation proof");
  const next = await f.successor("appointments.cancel");
  const target = value(await f.context.inspectAppointment(next, "appointments.cancel", new AbortController().signal));
  assert.equal(target.target.appointmentRef, "cliniko:appointment:71"); assert.equal(target.target.patientId, f.attempt.patientId);
  f.target.row.cancelled_at = "2026-11-01T10:04:00.000Z";
  assert.equal((await f.context.inspectAppointment(next, "appointments.cancel", new AbortController().signal)).ok, false);
});

test("withdrawn original context remains a constraint and cannot become a generic appointment fallback", async t => {
  const f = await incomingCallContextFixture({ sickDay: true }); t.after(f.close); await f.verify(); value(await f.read());
  assert.equal(f.context.hasOriginalAppointment(), true); assert.equal(f.context.current(), true);
  f.state.live = false;
  assert.equal(f.context.hasOriginalAppointment(), true); assert.equal(f.context.current(), false);
  assert.equal((await f.context.inspectAppointment(f.session, "appointments.cancel", new AbortController().signal)).ok, false);
});


test("prior call evidence retained during the incoming call still resolves the original purpose", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); await f.verify();
  const recordedAt = "2026-11-01T10:05:05.000Z", now = "2026-11-01T10:05:10.000Z";
  const observation = value(f.auth.sign({ ...f.unsigned, recordedAt }));
  Object.assign(f.observationRow, { notes: value(encodeTwilioOutboundTerminalObservation(observation)),
    created_at: recordedAt, updated_at: recordedAt });
  f.setTime(now); f.native.setNow(now);
  const context = value(await f.read());
  assert.equal(context.purpose, "followUp"); assert.equal(context.checkedAt, now);
  assert.equal(f.lists, 2); assert.equal(f.context.current(), true);
});

for (const fault of ["notification-after-inbound", "retention-in-future"] as const) {
  test(`late native retention does not permit ${fault}`, async t => {
    const f = await incomingCallContextFixture(); t.after(f.close); await f.verify();
    const now = "2026-11-01T10:05:10.000Z";
    const recordedAt = fault === "retention-in-future" ? "2026-11-01T10:05:11.000Z" : "2026-11-01T10:05:05.000Z";
    const receivedAt = fault === "notification-after-inbound" ? "2026-11-01T10:05:01.000Z" : f.unsigned.receivedAt;
    const observation = value(f.auth.sign({ ...f.unsigned, receivedAt, recordedAt }));
    Object.assign(f.observationRow, { notes: value(encodeTwilioOutboundTerminalObservation(observation)),
      created_at: recordedAt, updated_at: recordedAt });
    f.setTime(now); f.native.setNow(now);
    assert.equal((await f.read()).ok, false);
  });
}

for (const sickDay of [false, true]) {
  test(`verified incoming no-answer context resolves ${sickDay ? "exact sick-day" : "follow-up"} without answered-call evidence`, async t => {
    const f = await incomingCallContextFixture({ sickDay }); t.after(f.close); f.replaceWithUnanswered(); await f.verify();
    assert.equal(value(await f.read()).purpose, sickDay ? "sickDay" : "followUp");
    assert.ok(f.native.calls.slice(1).every(call => call.method === "GET"));
    assert.ok(f.queries.some(q => q.operation === "approveIncomingCallContext" && q.observation.record.status === "no-answer"));
  });
}

test("no-answer native context still requires its own authenticated source and current read grant", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); const n = f.replaceWithUnanswered(); await f.verify();
  n.row.notes = value(encodeTwilioOutboundUnansweredObservation({ ...n.observation, authentication: "0".repeat(64) }));
  assert.equal((await f.read()).ok, false);
  n.row.notes = value(encodeTwilioOutboundUnansweredObservation(n.observation));
  f.state.allow = q => q.operation !== "readUnansweredObservation";
  assert.equal((await f.read()).ok, false);
});

test("a completed-family record cannot be relabelled as an unanswered source", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); await f.verify();
  Object.assign(f.observationRow, { recall_type: { links: { self: "https://api.au5.cliniko.com/v1/recall_types/67" } } });
  assert.equal((await f.read()).ok, false);
});

test("actual signed no-answer producer provenance is readable for the same independently verified returning patient", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close);
  const p = await twilioOutboundUnansweredProducerFixture({ request: f.native.request });
  const received = value(p.runtime.authenticateStatus(p.request()));
  const retained = value(await p.producer.observeStatus(p.request(), new AbortController().signal));
  if (retained.kind !== "accepted") assert.fail("actual signed producer must retain the native no-answer record");
  const stored = p.native.rows.get(retained.recallRef.split(":").at(-1)!)!;
  const observation = value(decodeTwilioOutboundUnansweredObservation(stored.notes));
  assert.equal(p.auth.matchesOriginal(observation, received.call.context, p.config.accountSid), true);
  f.originalRow.notes = value(encodeOutboundLaunchAttempt(p.original.attempt));
  f.native.rows.delete("50"); f.add("51", "67", String(stored.notes), observation.recordedAt);
  f.config.authentication = new TwilioOutboundTerminalObservationAuthentication(p.key, p.auth.binding());
  f.config.unanswered.authentication = p.auth;
  const context = value(f.make()); await f.verify();
  assert.equal(value(await context.read(f.session, new AbortController().signal)).purpose, "followUp");
  assert.equal(p.carrierRequests, 1); assert.equal(p.native.calls.filter(c => c.method === "POST").length, 1);
});

for (const fault of ["destination", "original-action"] as const) {
  test(`authenticated notification must match the original ${fault}`, async t => {
    const f = await incomingCallContextFixture(); t.after(f.close); await f.verify();
    const observation = value(f.auth.sign({ ...f.unsigned, ...(fault === "destination" ? { number: "+12025550999" }
      : { original: { ...f.unsigned.original, actionRef: randomUUID() } }) }));
    f.observationRow.notes = value(encodeTwilioOutboundTerminalObservation(observation));
    assert.equal((await f.read()).ok, false);
  });
}


test("registered contact changed during a history permission wait prevents the protected native history GET", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); await f.verify(); let changed = false;
  f.state.allow = async q => {
    if (!changed && q.operation === "readIncomingCallHistory") { await Promise.resolve(); changed = true; f.setEmail("different-registered@example.test"); }
    return true;
  };
  assert.equal((await f.read()).ok, false); assert.equal(f.lists, 0); assert.equal(changed, true);
});

test("patient permission withdrawn after the purpose grant still prevents disclosure of native context", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); await f.verify();
  f.state.allow = async q => { if (q.operation === "approveIncomingCallContext") { await Promise.resolve(); f.setPermitted(false); } return true; };
  assert.equal((await f.read()).ok, false); assert.ok(f.queries.some(q => q.operation === "approveIncomingCallContext"));
});


test("a native original changed during the decoded purpose grant invalidates the whole snapshot before disclosure", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); await f.verify();
  f.state.allow = async q => {
    if (q.operation === "approveIncomingCallContext") {
      await Promise.resolve(); f.native.rows.get("30")!.notes = value(encodeOutboundRecipientRequest({ ...f.native.request,
        policy: { ...f.native.request.policy, version: "changed-after-native-observation" } }));
    }
    return true;
  };
  assert.equal((await f.read()).ok, false); assert.equal(f.lists, 2);
});

test("native contact withdrawn at the first history gate prevents its actual protected dispatch", async t => {
  const f = await incomingCallContextFixture(); t.after(f.close); await f.verify();
  let changed = false;
  f.state.allow = async q => {
    if (!changed && q.operation === "readIncomingCallHistory") {
      changed = true; await Promise.resolve(); f.setEmail("withdrawn-native-contact@example.test");
    }
    return true;
  };
  assert.equal((await f.read()).ok, false); assert.equal(f.lists, 0); assert.equal(changed, true);
});
