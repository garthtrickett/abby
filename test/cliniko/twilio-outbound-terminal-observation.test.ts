import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { decodeTwilioOutboundTerminalObservation, encodeTwilioOutboundTerminalObservation,
  twilioOutboundTerminalActionRef, twilioOutboundTerminalObservationDigest, TwilioOutboundTerminalObservationAuthentication } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import type { TwilioOutboundTerminalObservation } from "../../src/cliniko/twilio-outbound-terminal-observation.ts";
import { decodeTwilioOutboundReport, encodeTwilioOutboundReport } from "../../src/cliniko/twilio-outbound-report.ts";
import { twilioOutboundTerminalObservationValue as fixture } from "../support/twilio-outbound-terminal-observation.ts";
import { value } from "../support/outbound-records.ts";

test("terminal purpose protocol is stable, preallocated and independent of verifier or policy selection", () => {
  const session = "11111111-1111-4111-8111-111111111111";
  assert.equal(twilioOutboundTerminalActionRef(session), "287225e6-3775-4b73-8050-467deba2ae37");
  assert.notEqual(twilioOutboundTerminalActionRef(randomUUID()), twilioOutboundTerminalActionRef(session));
  for (const bad of ["", "not-a-uuid", "abcdefab-cdef-4abc-8abc-abcdefabcdef".toUpperCase(), session.replace("4111", "5111")])
    assert.equal(twilioOutboundTerminalActionRef(bad), undefined);
  const f = fixture();
  for (const key of [Buffer.alloc(32, 18), Buffer.alloc(32, 19)]) {
    const auth = new TwilioOutboundTerminalObservationAuthentication(key, f.auth.binding());
    assert.equal(value(auth.sign(f.unsigned)).actionRef, f.observation.actionRef);
    assert.notEqual(auth.authenticationBinding(), f.auth.authenticationBinding());
  }
});

test("canonical frozen completed-notification record contains no end time, complete flag or contact assertion", () => {
  const f = fixture(), notes = value(encodeTwilioOutboundTerminalObservation(f.observation)), decoded = value(decodeTwilioOutboundTerminalObservation(notes));
  assert.deepEqual(decoded, f.observation); assert.ok(notes.length <= 1050); assert.equal(f.auth.verify(decoded), true);
  assert.equal(f.auth.matchesOriginal(decoded, f.context, decoded.accountSid), true);
  assert.match(twilioOutboundTerminalObservationDigest(decoded)!, /^[a-f0-9]{64}$/);
  for (const item of [decoded, decoded.scope, decoded.original]) assert.equal(Object.isFrozen(item), true);
  for (const name of ["endedAt", "terminal", "complete", "contact", "transcript", "patientVerified", "permission"])
    assert.equal(Object.hasOwn(decoded, name), false);
  assert.equal(decodeTwilioOutboundReport(notes).ok, false);
  assert.equal(decodeTwilioOutboundTerminalObservation(value(encodeTwilioOutboundReport(f.prior.report))).ok, false);
});

test("every changed semantic field fails MAC authentication and alias actions refuse encoding", () => {
  const f = fixture();
  const patches: Partial<TwilioOutboundTerminalObservation>[] = [
    { scope: { ...f.observation.scope, clinicId: "other" } }, { businessId: "999" }, { patientId: "999" },
    { credentialFingerprint: "b".repeat(64) }, { original: { ...f.observation.original, digest: "a".repeat(64) } },
    { original: { ...f.observation.original, recallRef: "cliniko:recall:999" } },
    { original: { ...f.observation.original, actionRef: randomUUID() } }, { accountSid: "AC" + "a".repeat(32) },
    { callSid: "CA" + "a".repeat(32) }, { number: "+12025550999" }, { receivedAt: "2026-11-01T10:02:59.000Z" },
    { recordedAt: "2026-11-01T10:04:01.000Z" }, { authentication: "f".repeat(64) },
  ];
  for (const patch of patches) {
    const changed = { ...f.observation, ...patch };
    assert.notDeepEqual(changed, f.observation, "tamper control must change evidence");
    assert.equal(encodeTwilioOutboundTerminalObservation(changed).ok, true, Object.keys(patch).join());
    assert.equal(f.auth.verify(changed), false, Object.keys(patch).join());
  }
  for (const actionRef of [randomUUID(), f.context.sessionActionRef, f.context.original.attempt.actionRef])
    assert.equal(encodeTwilioOutboundTerminalObservation({ ...f.observation, actionRef }).ok, false);
  const sessionActionRef = randomUUID();
  assert.equal(f.auth.verify({ ...f.observation, sessionActionRef, actionRef: twilioOutboundTerminalActionRef(sessionActionRef)! }), false);
});

test("captured canonical key/provider selection survives caller mutation but excludes another key or domain", () => {
  const f = fixture(), key = Buffer.from(f.key), provider = { ...f.auth.binding() };
  const auth = new TwilioOutboundTerminalObservationAuthentication(key, provider), binding = auth.authenticationBinding();
  key.fill(0); provider.bindingDigest = "0".repeat(64);
  assert.equal(auth.verify(f.observation), true); assert.equal(auth.authenticationBinding(), binding);
  const reordered = { bindingDigest: auth.binding().bindingDigest, ref: auth.binding().ref };
  const same = new TwilioOutboundTerminalObservationAuthentication(f.key, reordered);
  assert.equal(same.verify(f.observation), true); assert.equal(same.authenticationBinding(), binding);
  for (const other of [new TwilioOutboundTerminalObservationAuthentication(Buffer.alloc(32, 18), auth.binding()),
    new TwilioOutboundTerminalObservationAuthentication(f.key, { ...auth.binding(), ref: "other" }),
    new TwilioOutboundTerminalObservationAuthentication(f.key, { ...auth.binding(), bindingDigest: "a".repeat(64) })])
    assert.equal(other.verify(f.observation), false);
  assert.notEqual(f.prior.auth.authenticationBinding(), auth.authenticationBinding());
  assert.equal(Reflect.set(auth, "verify", () => true), false); assert.equal(Reflect.set(auth, "matchesOriginal", () => true), false);
});

for (const extension of [{ complete: true }, { endedAt: "2026-11-01T10:02:00.000Z" }, { contact: "completeNoStop" },
  { transcript: "private source phrase" }, { permission: true }, { status: "busy" }, { status: "failed" }, { status: "in-progress" }])
test(`completed-notification format rejects ${Object.keys(extension).join()} extension ${Object.values(extension).join()}`, () => {
  const f = fixture(); assert.equal(f.auth.sign({ ...f.unsigned, ...extension } as typeof f.unsigned).ok, false);
});

test("canonical decoder rejects alternate wire forms, padding, malformed dates and oversized records", () => {
  const f = fixture(), notes = value(encodeTwilioOutboundTerminalObservation(f.observation)), lines = notes.split("\n"), a = JSON.parse(lines[2]!);
  for (const changed of [notes + "\n", notes.replace("observation v1", "observation v2"), notes.replace(lines[2]!, " " + lines[2]), "x".repeat(1051)])
    assert.equal(decodeTwilioOutboundTerminalObservation(changed).ok, false);
  for (const index of [2, 5, 6, 8, 12]) {
    const changed = structuredClone(a); changed[index] += "=";
    assert.equal(decodeTwilioOutboundTerminalObservation([lines[0], lines[1], JSON.stringify(changed), lines[3]].join("\n")).ok, false);
  }
  for (const patch of [{ receivedAt: "2026-02-30T10:03:00.000Z" }, { receivedAt: "2026-11-01T10:03:00Z" },
    { recordedAt: "2026-11-01T10:02:00.000Z" }, { scope: { ...f.unsigned.scope, tenantId: "t".repeat(97) } }])
    assert.equal(f.auth.sign({ ...f.unsigned, ...patch }).ok, false);
  assert.equal(f.auth.sign(f.observation).ok, false, "an existing signed record is never silently re-signed");
  assert.throws(() => new TwilioOutboundTerminalObservationAuthentication(Buffer.alloc(31), f.auth.binding()));
});

test("authentic notification still needs its exact captured original context and observation clock", () => {
  const f = fixture();
  for (const context of [{ ...f.context, sessionActionRef: randomUUID() }, { ...f.context, number: "+12025550999" },
    { ...f.context, attemptDigest: "a".repeat(64) }, { ...f.context, original: { ...f.context.original, recallRef: "cliniko:recall:999" } },
    { ...f.context, original: { ...f.context.original, attempt: { ...f.context.original.attempt, patientId: "999" } } }])
    assert.equal(f.auth.matchesOriginal(f.observation, context, f.observation.accountSid), false);
  assert.equal(f.auth.matchesOriginal(f.observation, f.context, "AC" + "a".repeat(32)), false);
  const early = value(f.auth.sign({ ...f.unsigned, receivedAt: "2026-11-01T09:00:00.000Z" }));
  assert.equal(f.auth.verify(early), true); assert.equal(f.auth.matchesOriginal(early, f.context, early.accountSid), false);
  const alias = { ...f.context, reportActionRef: f.observation.actionRef };
  assert.equal(f.auth.matchesOriginal(f.observation, alias, f.observation.accountSid), false);
});
