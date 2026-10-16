// E2E-419: separate current proof and played phase consent bindings; admitted serving remains separate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { readClassMovementConsent } from "../../src/core/class-movement-consent.ts";
import type { ActionRequest } from "../../src/core/model.ts";
import { deadline, now, setup, success } from "./fixture.ts";

async function partialMove(admissionDeadline = deadline, termsDeadline = deadline) {
  const app = await setup(`stage-consent-${randomUUID()}`, { reschedule: "execute" });
  const callId = `${app.callId}-admitted`, sessionId = `session-${randomUUID()}`;
  success(await app.runtime.admit(callId, { ...app.policy, reschedulingEnabled: true, staffWorkEnabled: true }, {
    key: { accountRef: "synthetic-class-consent", providerCallRef: callId }, dialedNumber: "+6125550101", acceptedAt: now, deadline: admissionDeadline,
  }));
  success(await app.runtime.activate(callId, sessionId, now));
  const request: Extract<ActionRequest, { kind: "reschedule" }> = { kind: "reschedule", patient: app.patient,
    target: { scope: app.scope, patientRef: app.patient.patientRef, appointmentRef: "class-original",
      startsAt: "2026-09-29T11:00:00.000Z", endsAt: "2026-09-29T12:00:00.000Z", timeZone: "Australia/Sydney" },
    offer: { ...app.offer("class", "class-replacement"), startsAt: "2026-09-30T11:00:00.000Z" },
    terms: { version: "class-fees-v1", approvedText: "No additional fee applies.", expiresAt: termsDeadline } };
  success(await app.runtime.acceptTurn({ callId, sessionId, turnId: "request", text: "Move my class", quality: "clear", at: now }, { kind: "requestAction", request }, now));
  let state = success(await app.runtime.read(callId)); const initial = Object.values(state.actions)[0]!;
  success(await app.runtime.startPresentation(callId, initial.presentationId, sessionId, now));
  success(await app.runtime.resolvePresentation(callId, initial.presentationId, "played", sessionId, now));
  success(await app.runtime.acceptTurn({ callId, sessionId, turnId: "initial-yes", text: "Yes", quality: "clear", at: now },
    { kind: "affirm", actionKey: initial.key, digest: initial.digest, affirmative: true }, now));
  const continuation = { ref: `class-move-stage:${randomUUID()}`, contractVersion: "staging-v1", ordinal: 1, stage: "original" } as const;
  app.host.writeResult = mutation => ({ kind: "classMovement", actionKey: mutation.actionKey, outcome: "pending", continuation,
    progress: { original: "notSent", replacement: "inspectedActive", caseAssociation: "unlinked" } });
  await app.worker.process(callId, `${initial.key}:write`, now);
  state = success(await app.runtime.read(callId)); const action = state.actions[initial.key]!;
  const evidence = { callId, sessionId, policyVersion: state.policy.policyVersion, continuation,
    patient: { ...app.patient, verificationRef: `renewed-${randomUUID()}` },
    expiresAt: new Date(Date.parse(now) + 1000).toISOString() };
  return { ...app, state, action, evidence };
}

test("a later class stage binds current same-patient proof and inspected facts to a new digest", async () => {
  const f = await partialMove(), consent = readClassMovementConsent(f.state, f.action, f.evidence, now);
  assert.ok(consent); assert.notEqual(consent.digest, f.action.digest);
  assert.equal(consent.evidence.patient.patientRef, f.patient.patientRef);
  const renewed = readClassMovementConsent(f.state, f.action, { ...f.evidence,
    patient: { ...f.evidence.patient, verificationRef: `renewed-again-${randomUUID()}` } }, now);
  assert.ok(renewed); assert.notEqual(renewed.digest, consent.digest);
  assert.equal(f.host.writes.length, 1, "preparing consent grants no further send");
  assert.equal(Object.isFrozen(consent.evidence.patient.scope), true);
});

test("a still-current same-patient proof can cover another stage without extending its expiry", async () => {
  const f = await partialMove();
  const original = readClassMovementConsent(f.state, f.action, { ...f.evidence, patient: f.patient }, now);
  assert.ok(original);
  assert.equal(original.evidence.patient.verificationRef, f.patient.verificationRef);
  assert.equal(original.evidence.patient.expiresAt, f.patient.expiresAt);
  assert.notEqual(original.digest, f.action.digest, "the original affirmation cannot consent to this stage");
  assert.equal(readClassMovementConsent(f.state, f.action, { ...f.evidence,
    patient: { ...f.evidence.patient, patientRef: "another-patient" } }, now), undefined);
});

test("an activated class move follows its renewed session lease after the startup admission deadline", async () => {
  const startupDeadline = new Date(Date.parse(now) + 1000).toISOString();
  const f = await partialMove(startupDeadline), at = new Date(Date.parse(now) + 65_000).toISOString();
  for (const seconds of [20, 40, 60]) {
    const current = success(await f.runtime.read(f.state.callId));
    success(await f.runtime.renewSession(f.state.callId, f.evidence.sessionId, current.sessionLease!.version,
      new Date(Date.parse(now) + seconds * 1000).toISOString()));
  }
  const live = success(await f.runtime.read(f.state.callId));
  assert.equal(live.lifecycle, "active");
  assert.equal(live.admission!.deadline, startupDeadline, "activation does not extend the startup deadline");
  const evidence = { ...f.evidence, expiresAt: new Date(Date.parse(at) + 1000).toISOString() };
  const consent = readClassMovementConsent(live, live.actions[f.action.key]!, evidence, at);
  assert.ok(consent, "startup expiry cannot shorten an already active renewed lease");
  assert.equal(consent.evidence.patient.expiresAt, f.patient.expiresAt, "session renewal does not extend patient proof");
  assert.equal(readClassMovementConsent(live, live.actions[f.action.key]!, { ...evidence,
    expiresAt: new Date(Date.parse(live.sessionLease!.expiresAt) + 1).toISOString() }, at), undefined);
  assert.equal(readClassMovementConsent(live, live.actions[f.action.key]!, evidence, live.sessionLease!.expiresAt), undefined);
  assert.equal(readClassMovementConsent({ ...live, lifecycle: "ended" }, live.actions[f.action.key]!, evidence, at), undefined);
  assert.equal(f.host.writes.length, 1, "renewing the lease and preparing consent grant no send");
});

test("current patient proof cannot extend the separately approved movement terms", async () => {
  const termsDeadline = new Date(Date.parse(now) + 500).toISOString();
  const f = await partialMove(deadline, termsDeadline);
  const shorter = { ...f.evidence, expiresAt: new Date(Date.parse(now) + 100).toISOString() };
  assert.ok(readClassMovementConsent(f.state, f.action, shorter, now));
  assert.equal(readClassMovementConsent(f.state, f.action, f.evidence, now), undefined,
    "a phase confirmation cannot outlive its independently approved terms");
  assert.equal(readClassMovementConsent(f.state, f.action, f.evidence, termsDeadline), undefined,
    "live patient proof and a live session cannot revive expired terms");
  assert.equal(f.host.writes.length, 1);
});

test("stale call, session, policy and rotated stage bindings require new consent", async () => {
  const f = await partialMove();
  for (const changed of [{ callId: "another-call" }, { sessionId: "another-session" }, { policyVersion: "policy-2" },
    { continuation: { ...f.evidence.continuation, ref: `class-move-stage:${randomUUID()}` } },
    { continuation: { ...f.evidence.continuation, stage: "association" } },
    { continuation: { ...f.evidence.continuation, ordinal: 2 } },
    { continuation: { ...f.evidence.continuation, contractVersion: "staging-v2" } }])
    assert.equal(readClassMovementConsent(f.state, f.action, { ...f.evidence, ...changed }, now), undefined);
});

test("revocation, lease loss and malformed deadlines cannot extend class-stage authority", async () => {
  const f = await partialMove();
  for (const changed of [
    { lifecycle: "ended" as const }, { callerIdentityDenied: "sharedPhone" as const },
    { policy: { ...f.state.policy, automationEnabled: false } },
    { policy: { ...f.state.policy, staffWorkEnabled: false } },
    { policy: { ...f.state.policy, reschedulingEnabled: false } },
    { sessionLease: { ...f.state.sessionLease!, expiresAt: now } },
    { sessionLease: { ...f.state.sessionLease!, expiresAt: "invalid" } },
    { admission: { ...f.state.admission!, deadline: "invalid" } },
  ]) assert.equal(readClassMovementConsent({ ...f.state, ...changed }, f.action, f.evidence, now), undefined);
  assert.equal(readClassMovementConsent(f.state, f.action, { ...f.evidence, expiresAt: now }, now), undefined);
  assert.equal(readClassMovementConsent(f.state, f.action, { ...f.evidence, expiresAt: deadline }, now), undefined);
  assert.equal(readClassMovementConsent(f.state, f.action, { ...f.evidence,
    patient: { ...f.evidence.patient, expiresAt: now } }, now), undefined);
});

test("private fields and getters cannot enter a class-stage consent binding", async () => {
  const f = await partialMove(); let getterCalls = 0;
  const poisoned = { ...f.evidence, get patient() { getterCalls++; return f.evidence.patient; } };
  assert.equal(readClassMovementConsent(f.state, f.action, poisoned, now), undefined);
  assert.equal(getterCalls, 0);
  assert.equal(readClassMovementConsent(f.state, f.action, { ...f.evidence, nativePatientId: "private-canary" }, now), undefined);
  assert.equal(readClassMovementConsent(f.state, f.action, { ...f.evidence,
    patient: { ...f.evidence.patient, email: "private@example.test" } }, now), undefined);
  const consent = readClassMovementConsent(f.state, f.action, f.evidence, now); assert.ok(consent);
  f.evidence.patient.verificationRef = "changed-after-validation";
  assert.notEqual(consent.evidence.patient.verificationRef, f.evidence.patient.verificationRef);
});
