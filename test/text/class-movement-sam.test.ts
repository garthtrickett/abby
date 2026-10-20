// E2E-419: actual SAM phase effects, redacted results and recovery retirement; admitted serving remains separate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ActionRequest, HostWriteReceipt, TurnInterpretation } from "../../src/core/model.ts";
import type { ClassMovementConsent } from "../../src/core/class-movement-consent.ts";
import { readActiveClassMovementConsent, readClassMovementConsent } from "../../src/core/class-movement-consent.ts";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import { POSSIBLE_SEND_RECOVERY_DELAY_MS } from "../../src/core/model.ts";
import { summarizeCall } from "../../src/reference/call-review.ts";
import { commandProgress } from "../../src/reference/command-progress.ts";
import { CallOutcomeReport } from "../../src/reference/call-outcome-report.ts";
import { capabilityCatalogue } from "../../src/reference/capability-catalogue.ts";
import { matchesSchema } from "../../src/reference/schema-shapes.ts";
import { requestBoundaryText } from "../../src/core/request-boundary.ts";
import { clarificationText } from "../../src/core/clarification.ts";
import { financialEvidenceText } from "../../src/core/financial-evidence.ts";
import { now, deadline, setup, success, FakeHost } from "./fixture.ts";

const progress = { original: "notSent", replacement: "inspectedActive", caseAssociation: "unlinked" } as const;
async function activeMove(label: string) {
  const app = await setup(label, { reschedule: "execute" });
  const callId = `${app.callId}-movement`, sessionId = `session-${randomUUID()}`;
  const policy = { ...app.policy, reschedulingEnabled: true, staffWorkEnabled: true };
  success(await app.runtime.admit(callId, policy, {
    key: { accountRef: "synthetic-class-movement", providerCallRef: callId }, dialedNumber: "+6125550101", acceptedAt: now, deadline,
  }));
  success(await app.runtime.activate(callId, sessionId, now));
  const state = async () => success(await app.runtime.read(callId));
  const turn = (turnId: string, text: string, interpretation: TurnInterpretation) => app.runtime.acceptTurn({
    callId, sessionId, turnId, text, quality: "clear", at: now,
  }, interpretation, now);
  const request: Extract<ActionRequest, { kind: "reschedule" }> = {
    kind: "reschedule", patient: app.patient,
    target: { scope: app.scope, appointmentRef: "original-class", patientRef: app.patient.patientRef,
      startsAt: "2026-09-29T11:00:00.000Z", endsAt: "2026-09-29T12:00:00.000Z", timeZone: "Australia/Sydney" },
    offer: { ...app.offer("class", "replacement-class"), startsAt: "2026-09-30T11:00:00.000Z" },
    terms: { version: "staged-contract-v1", approvedText: "This class move requires separate attendance and membership stages. An unfinished move needs clinic review.", expiresAt: deadline },
  };
  success(await turn("propose", "Move my class attendance", { kind: "requestAction", request }));
  const action = Object.values((await state()).actions)[0]; assert.ok(action);
  success(await app.runtime.startPresentation(callId, action.presentationId, sessionId, now));
  success(await app.runtime.resolvePresentation(callId, action.presentationId, "played", sessionId, now));
  success(await turn("confirm", "Yes", { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true }));
  const continuation = { ref: `class-move-stage:${randomUUID()}`, contractVersion: "staged-contract-v1", ordinal: 1, stage: "original" } as const;
  app.host.writeResult = mutation => ({ kind: "classMovement", actionKey: mutation.actionKey, outcome: "pending", progress, continuation });
  return { ...app, callId, sessionId, state, turn, action, effectId: `${action.key}:write`, continuation };
}

test("SAM records a partial native movement without reusing the original affirmation", async () => {
  const app = await activeMove(`partial-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  let state = await app.state(), action = state.actions[app.action.key]!;
  assert.equal(action.status, "pendingContinuation");
  assert.deepEqual(action.mutation, app.action.mutation, "original patient, target, offer and terms stay immutable");
  assert.equal(action.digest, app.action.digest);
  assert.equal(state.effects[app.effectId]?.status, "completed");
  assert.equal(app.host.writes.length, 1);
  const summary = success(summarizeCall(state)), projected = commandProgress(state, "stage-progress");
  const observed = { outcome: "pending", progress };
  assert.deepEqual(summary.actions[0]?.classMovement, observed);
  assert.deepEqual(projected.actions[0]?.classMovement, observed);
  const contradictory = structuredClone(state);
  contradictory.actions[app.action.key] = { ...contradictory.actions[app.action.key]!, classMovement: { outcome: "moved", progress } };
  assert.deepEqual(summarizeCall(contradictory), { ok: false, error: { kind: "storageCorrupt" } });
  assert.equal(matchesSchema(capabilityCatalogue["calls.read.v1"].resultSchema,
    { ok: true, value: { kind: "callSummary", call: summary } }), true);
  assert.equal(matchesSchema(capabilityCatalogue["appointments.enquiry.start.v1"].resultSchema,
    { ok: true, value: { kind: "appointmentAnswer", progress: projected } }), true);
  for (const value of [summary, projected]) {
    const serialized = JSON.stringify(value);
    for (const privateValue of [app.continuation.ref, app.patient.patientRef, app.patient.verificationRef, "original-class", "replacement-class"])
      assert.equal(serialized.includes(privateValue), false, "result readers expose only fixed public progress");
  }
  const report = success(await new CallOutcomeReport(app.ledger).list(app.scope));
  assert.equal(report.rows.find(row => row.callId === app.callId)?.unresolvedActions, 1);
  assert.equal(report.rows.find(row => row.callId === app.callId)?.committedActions, 0);
  for (const text of [requestBoundaryText(state, "externalAppointmentChange"),
    clarificationText("changeAfterSend", action), financialEvidenceText("paymentEvidenceUnavailable", action)]) {
    assert.match(text, /overall class move is not confirmed/);
    assert.match(text, /replacement attendance was last inspected as active/);
    assert.doesNotMatch(text, /Your appointment move is confirmed|No change was made/);
  }
  assert.match(state.callerMessages.at(-1)!, /overall class move is not confirmed/);
  const repeated = await app.turn("repeat-old-confirmation", "Yes", { kind: "affirm", actionKey: action.key, digest: action.digest, affirmative: true });
  assert.deepEqual(repeated, { ok: false, error: { kind: "confirmationMissing" } });
  success(await app.turn("status", "Has it moved?", { kind: "outcomeQuery" }));
  state = await app.state(); action = state.actions[app.action.key]!;
  assert.equal(action.status, "pendingContinuation");
  assert.match(state.callerMessages.at(-1)!, /replacement attendance was last inspected as active/);
  assert.match(state.callerMessages.at(-1)!, /fresh, separate confirmation/);
  assert.equal(app.host.writes.length, 1);
});

test("ending the admitted call retires continuation metadata and preserves inspected changes", async () => {
  const app = await activeMove(`end-partial-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  const before = (await app.state()).actions[app.action.key]!;
  const ended = success(await app.runtime.endCall(app.callId, app.sessionId, now, "callerDisconnected"));
  const action = ended.actions[app.action.key]!;
  assert.equal(ended.lifecycle, "ended"); assert.equal(action.status, "needsReview");
  assert.deepEqual(action.classMovement?.progress, before.classMovement?.progress);
  assert.equal(action.classMovement?.outcome, "needsReview");
  assert.equal(Object.hasOwn(action.classMovement!, "continuation"), false);
  assert.equal(app.host.writes.length, 1);
  success(await app.runtime.acceptHostResult(app.callId, app.effectId, { kind: "committed", actionKey: action.key, hostRef: "late-leg-ack" }, now));
  assert.equal((await app.state()).actions[action.key]?.status, "needsReview", "a completed first-phase effect cannot later promote the whole move");
});

test("an invalid next stage becomes review without erasing an uncertain original cancellation", async () => {
  const app = await activeMove(`unknown-original-${randomUUID()}`);
  app.host.writeResult = mutation => ({ kind: "classMovement", actionKey: mutation.actionKey, outcome: "pending",
    progress: { ...progress, original: "uncertain" }, continuation: { ...app.continuation, stage: "compensation" } });
  await app.worker.process(app.callId, app.effectId, now);
  const state = await app.state(), action = state.actions[app.action.key]!;
  assert.equal(action.status, "needsReview");
  assert.equal(action.classMovement?.progress.original, "uncertain");
  assert.equal(action.classMovement?.progress.replacement, "inspectedActive");
  assert.equal(Object.hasOwn(action.classMovement!, "continuation"), false);
  assert.match(state.callerMessages.at(-1)!, /cannot confirm whether the original attendance was cancelled/);
  assert.doesNotMatch(state.callerMessages.at(-1)!, /No change was made|class move is confirmed/);
});

test("private native fields in a malformed receipt never enter SAM or caller output", async () => {
  const app = await activeMove(`private-receipt-${randomUUID()}`), privateValue = "private-native-stage-canary";
  app.host.writeResult = mutation => ({ kind: "classMovement", actionKey: mutation.actionKey, outcome: "pending",
    progress: { ...progress, verificationRef: privateValue }, continuation: app.continuation }) as unknown as HostWriteReceipt;
  await assert.rejects(app.worker.process(app.callId, app.effectId, now), /invalidTransition/);
  const state = await app.state();
  assert.equal(state.actions[app.action.key]?.status, "dispatched");
  assert.equal(state.effects[app.effectId]?.status, "possiblySent");
  assert.equal(JSON.stringify(state).includes(privateValue), false);
  assert.equal(app.host.writes.length, 1);
});

async function nextConsent(app: Awaited<ReturnType<typeof activeMove>>, verificationRef = app.patient.verificationRef) {
  let state = await app.state();
  if (state.pendingPresentationId) {
    success(await app.runtime.startPresentation(app.callId, state.pendingPresentationId, app.sessionId, now));
    success(await app.runtime.resolvePresentation(app.callId, state.pendingPresentationId, "played", app.sessionId, now));
    state = await app.state();
  }
  const action = state.actions[app.action.key]!, movement = action.classMovement;
  assert.equal(movement?.outcome, "pending"); assert.ok(movement && movement.outcome === "pending");
  const request = action.mutation.request; assert.ok(request.kind === "reschedule");
  const evidence = { callId: app.callId, sessionId: app.sessionId, policyVersion: state.policy.policyVersion,
    continuation: movement.continuation, patient: { ...app.patient, verificationRef }, terms: { ...request.terms },
    expiresAt: new Date(Date.parse(now) + 1000).toISOString() };
  assert.deepEqual(await app.runtime.prepareClassMovementConsent(app.callId, action.key, evidence, now, state.conversationRevision - 1),
    { ok: false, error: { kind: "staleTurn" } });
  const prepared = success(await app.runtime.prepareClassMovementConsent(app.callId, action.key, evidence, now, state.conversationRevision));
  const consent = prepared.actions[action.key]!.classMovementConsent!;
  return { evidence, consent, effectId: `${action.key}:classStage:${consent.digest}`,
    affirm: () => app.turn(`phase-yes-${randomUUID()}`, "Yes", { kind: "classMovementAffirm", actionKey: action.key, digest: consent.digest }),
    play: async () => {
      success(await app.runtime.startPresentation(app.callId, consent.presentationId, app.sessionId, now));
      success(await app.runtime.resolvePresentation(app.callId, consent.presentationId, "played", app.sessionId, now));
    } };
}

test("new caller speech withdraws an affirmed unsent phase while a parked continuation remains available", async () => {
  const app = await activeMove(`phase-barge-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  success(await app.runtime.beginSpeech(app.callId, app.sessionId, now));
  assert.equal((await app.state()).actions[app.action.key]?.status, "pendingContinuation");
  const next = await nextConsent(app); await next.play(); success(await next.affirm());
  let calls = 0;
  Object.assign(app.host, { continueClassMovement: async (): Promise<HostWriteReceipt> => {
    calls++; return { kind: "rejected", actionKey: app.action.key, reason: "forbidden" };
  } });
  success(await app.runtime.beginSpeech(app.callId, app.sessionId, now));
  const state = await app.state();
  assert.equal(state.actions[app.action.key]?.status, "needsReview");
  assert.equal(state.effects[next.effectId]?.status, "canceled");
  assert.deepEqual(state.actions[app.action.key]?.classMovement?.progress, progress);
  await assert.rejects(app.worker.process(app.callId, next.effectId, now), /invalidTransition/);
  assert.equal(calls, 0);
});

for (const boundary of ["speech", "newTurn"] as const)
test(`a possibly-sent phase retains uncertainty after ${boundary} without retaining continuation authority`, async () => {
  const app = await activeMove(`phase-possible-${boundary}-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  const next = await nextConsent(app); await next.play(); success(await next.affirm());
  success(await app.runtime.markHostPossiblySent(app.callId, next.effectId, now));
  if (boundary === "speech") success(await app.runtime.beginSpeech(app.callId, app.sessionId, now));
  else success(await app.turn("new-request", "Another question", { kind: "unavailableAction", actionKind: "book" }));
  const state = await app.state(), action = state.actions[app.action.key]!;
  assert.equal(action.status, "needsReview");
  assert.equal(action.classMovement?.outcome, "needsReview");
  assert.deepEqual(action.classMovement?.progress, { ...progress, original: "uncertain" });
  assert.equal(action.classMovementConsent, undefined);
  assert.equal(state.effects[next.effectId]?.status, "possiblySent", "a new utterance cannot prove the native send did not happen");
  assert.equal(app.host.writes.length, 1);
});

test("native phase guards read only the exact played in-flight SAM consent without authorizing a new phase", async () => {
  const app = await activeMove(`phase-native-guard-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  const next = await nextConsent(app); await next.play(); success(await next.affirm());
  assert.equal(readActiveClassMovementConsent(await app.state(), next.effectId, now), undefined, "ready is not possibly sent");
  let guarded = false;
  Object.assign(app.host, { continueClassMovement: async (_mutation: unknown, consent: ClassMovementConsent): Promise<HostWriteReceipt> => {
    const state = await app.state(), action = state.actions[app.action.key]!, effect = state.effects[next.effectId];
    assert.ok(effect?.kind === "hostWrite");
    assert.deepEqual(readActiveClassMovementConsent(state, next.effectId, now), consent);
    assert.equal(readClassMovementConsent(state, action, consent.evidence, now), undefined, "an in-flight phase cannot prepare another send");
    assert.equal(readActiveClassMovementConsent(state, app.effectId, now), undefined, "the original write is not phase authority");
    assert.equal(readActiveClassMovementConsent(state, next.effectId, consent.evidence.expiresAt), undefined);
    const status = structuredClone(state); status.actions[action.key] = { ...action, status: "ready" };
    const interrupted = structuredClone(state), presentation = state.presentations[next.consent.presentationId];
    assert.ok(presentation?.kind === "speech");
    interrupted.presentations[presentation.id] = { ...presentation, status: "interrupted" };
    const wrongId = structuredClone(state); wrongId.effects[next.effectId] = { ...effect, id: "another-phase" };
    const wrongPayload = structuredClone(state);
    wrongPayload.effects[next.effectId] = { ...effect, mutation: { ...effect.mutation, payloadDigest: "another-digest" } };
    const parallel = structuredClone(state); parallel.effects["parallel-phase"] = { ...effect, id: "parallel-phase" };
    for (const invalid of [status, interrupted, wrongId, wrongPayload, parallel, { ...state, lifecycle: "ended" as const },
      { ...state, policy: { ...state.policy, automationEnabled: false } }])
      assert.equal(readActiveClassMovementConsent(invalid, next.effectId, now), undefined);
    guarded = true;
    return { kind: "classMovement", actionKey: action.key, outcome: "pending", progress: { ...progress, original: "inspectedCancelled" },
      continuation: { ...app.continuation, ref: `class-move-stage:${randomUUID()}`, ordinal: 2, stage: "association" } };
  } });
  await app.worker.process(app.callId, next.effectId, now);
  assert.equal(guarded, true);
  assert.equal(readActiveClassMovementConsent(await app.state(), next.effectId, now), undefined, "a completed phase cannot be replayed");
});

test("SAM advances actual distinct stage effects only after each fresh played confirmation", async () => {
  const app = await activeMove(`separate-stages-${randomUUID()}`), stageCalls: ClassMovementConsent[] = [];
  await app.worker.process(app.callId, app.effectId, now);
  Object.assign(app.host, { continueClassMovement: async (_mutation: unknown, consent: ClassMovementConsent): Promise<HostWriteReceipt> => {
    stageCalls.push(consent);
    return consent.evidence.continuation.stage === "original"
      ? { kind: "classMovement", actionKey: app.action.key, outcome: "pending",
        progress: { ...progress, original: "inspectedCancelled" },
        continuation: { ...app.continuation, ref: `class-move-stage:${randomUUID()}`, ordinal: 2, stage: "association" } }
      : consent.evidence.continuation.stage === "association"
      ? { kind: "classMovement", actionKey: app.action.key, outcome: "pending",
        progress: { ...progress, original: "inspectedCancelled", caseAssociation: "uncertain" },
        continuation: { ...app.continuation, ref: `class-move-stage:${randomUUID()}`, ordinal: 3, stage: "associationInspection" } }
      : { kind: "classMovement", actionKey: app.action.key, outcome: "moved", hostRef: "inspected-joint-class-move",
        progress: { ...progress, original: "inspectedCancelled", caseAssociation: "inspectedLinked" } };
  } });
  const original = await nextConsent(app);
  assert.deepEqual(await original.affirm(), { ok: false, error: { kind: "confirmationMissing" } });
  await original.play(); success(await original.affirm());
  assert.equal(stageCalls.length, 0);
  await app.worker.process(app.callId, original.effectId, now);
  assert.equal((await app.state()).actions[app.action.key]?.status, "pendingContinuation");
  assert.equal(stageCalls.length, 1);
  const association = await nextConsent(app);
  assert.notEqual(association.consent.digest, original.consent.digest);
  assert.deepEqual(await original.affirm(), { ok: false, error: { kind: "confirmationMissing" } });
  assert.deepEqual(await association.affirm(), { ok: false, error: { kind: "confirmationMissing" } });
  await association.play(); success(await association.affirm());
  await app.worker.process(app.callId, association.effectId, now);
  assert.equal((await app.state()).actions[app.action.key]!.status, "pendingContinuation");
  assert.equal(stageCalls.length, 2);
  const inspection = await nextConsent(app);
  assert.notEqual(inspection.consent.digest, association.consent.digest);
  assert.match(inspection.consent.evidence.continuation.stage, /^associationInspection$/);
  const inspectionState = await app.state(), inspectionAction = inspectionState.actions[app.action.key]!;
  const inspectionSpeech = inspectionState.presentations[inspectionAction.presentationId];
  assert.ok(inspectionSpeech?.kind === "speech");
  assert.match(inspectionSpeech.approvedText, /inspection makes no further attendance change/);
  assert.deepEqual(await inspection.affirm(), { ok: false, error: { kind: "confirmationMissing" } });
  await inspection.play(); success(await inspection.affirm());
  await app.worker.process(app.callId, inspection.effectId, now);
  const state = await app.state(), action = state.actions[app.action.key]!;
  assert.equal(stageCalls.length, 3); assert.equal(app.host.writes.length, 1, "initial host write is never used for a continuation");
  assert.equal(action.status, "committed"); assert.equal(action.classMovement?.outcome, "moved");
  assert.deepEqual(action.mutation, app.action.mutation); assert.equal(action.digest, app.action.digest);
  assert.deepEqual(stageCalls.map(c => c.evidence.patient.verificationRef), [app.patient.verificationRef, app.patient.verificationRef, app.patient.verificationRef],
    "a still-current proof needs no new challenge solely because the native stage changed");
  assert.equal(action.classMovementConsent, undefined);
  assert.equal(state.effects[original.effectId]?.status, "completed");
  assert.equal(state.effects[association.effectId]?.status, "completed");
  assert.equal(state.effects[inspection.effectId]?.status, "completed");
  await assert.rejects(app.worker.process(app.callId, original.effectId, now), /invalidTransition/);
  assert.equal(stageCalls.length, 3);
});

test("a host without a staged continuation method cannot replay its initial write", async () => {
  const app = await activeMove(`no-stage-host-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  const next = await nextConsent(app); await next.play(); success(await next.affirm());
  await app.worker.process(app.callId, next.effectId, now);
  const state = await app.state(), action = state.actions[app.action.key]!;
  assert.equal(app.host.writes.length, 1);
  assert.equal(state.effects[next.effectId]?.status, "canceled");
  assert.equal(action.status, "needsReview"); assert.deepEqual(action.classMovement?.progress, progress);
  assert.equal(action.classMovementConsent, undefined);
  assert.equal(Object.values(state.staffItems)[0]?.reason, "unsupported");
});

test("recovery with a new host cannot reconstruct a native stage from its stored reference", async () => {
  const app = await activeMove(`recover-phase-owner-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  const next = await nextConsent(app); await next.play(); success(await next.affirm());
  const replacementHost = new FakeHost();
  const report = success(await new EffectRecovery(app.ledger, () => replacementHost, app.scope).recover(now));
  assert.equal(report.processed, 1); assert.deepEqual(report.failed, []);
  const state = await app.state(), action = state.actions[app.action.key]!;
  assert.equal(state.effects[next.effectId]?.status, "canceled");
  assert.equal(action.status, "needsReview");
  assert.deepEqual(action.classMovement?.progress, progress);
  assert.equal(action.classMovementConsent, undefined);
  assert.equal(Object.hasOwn(action.classMovement!, "continuation"), false);
  assert.equal(app.host.writes.length, 1); assert.equal(replacementHost.writes.length, 0);
});

test("recovery of a possibly-sent class phase preserves uncertainty despite a later generic exact commit", async () => {
  const app = await activeMove(`recover-possible-phase-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  const next = await nextConsent(app); await next.play(); success(await next.affirm());
  success(await app.runtime.markHostPossiblySent(app.callId, next.effectId, now));
  const replacementHost = new FakeHost();
  replacementHost.reconcileResult = mutation => ({ kind: "exactCommit", actionKey: mutation.actionKey, hostRef: "one-leg-only" });
  const recovery = new EffectRecovery(app.ledger, () => replacementHost, app.scope);
  const later = new Date(Date.parse(now) + POSSIBLE_SEND_RECOVERY_DELAY_MS + 1).toISOString();
  assert.equal(success(await recovery.recover(later)).recovered, 1);
  let action = (await app.state()).actions[app.action.key]!;
  assert.equal(action.status, "uncertain");
  assert.equal(action.classMovement?.progress.original, "uncertain");
  assert.equal(action.classMovement?.progress.replacement, "inspectedActive");
  assert.equal(action.classMovementConsent, undefined);
  assert.equal(success(await recovery.recover(later)).processed, 1);
  action = (await app.state()).actions[app.action.key]!;
  assert.equal(action.status, "needsReview");
  assert.equal(action.classMovement?.outcome, "needsReview");
  assert.equal(action.classMovement?.progress.original, "uncertain");
  assert.equal(replacementHost.reconciliations.length, 1);
  assert.equal(replacementHost.writes.length, 0); assert.equal(app.host.writes.length, 1);
});

test("expired phase proof prevents dispatch after consent without erasing the replacement", async () => {
  const app = await activeMove(`expire-phase-${randomUUID()}`); let calls = 0;
  await app.worker.process(app.callId, app.effectId, now);
  Object.assign(app.host, { continueClassMovement: async () => { calls++; throw new Error("must not dispatch"); } });
  const next = await nextConsent(app); await next.play(); success(await next.affirm());
  await assert.rejects(app.worker.process(app.callId, next.effectId, new Date(Date.parse(now) + 1000).toISOString()), /confirmationMissing/);
  const state = await app.state();
  assert.equal(calls, 0); assert.equal(state.effects[next.effectId]?.status, "pending");
  assert.deepEqual(state.actions[app.action.key]?.classMovement?.progress, progress);
});

test("interrupting a phase readback retires that consent and preserves inspected native facts", async () => {
  const app = await activeMove(`phase-interrupted-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  const next = await nextConsent(app);
  success(await app.runtime.startPresentation(app.callId, next.consent.presentationId, app.sessionId, now));
  success(await app.runtime.resolvePresentation(app.callId, next.consent.presentationId, "interrupted", app.sessionId, now));
  assert.deepEqual(await next.affirm(), { ok: false, error: { kind: "confirmationMissing" } });
  const action = (await app.state()).actions[app.action.key]!;
  assert.equal(action.status, "needsReview"); assert.deepEqual(action.classMovement?.progress, progress);
  assert.equal(action.classMovementConsent, undefined); assert.equal(app.host.writes.length, 1);
});

test("explicit identity denial retires a pending class stage without erasing inspected changes", async () => {
  const app = await activeMove(`phase-identity-denied-${randomUUID()}`);
  await app.worker.process(app.callId, app.effectId, now);
  const next = await nextConsent(app);
  await next.play();
  success(await app.turn("identity-denied", "That is not my booking", { kind: "callerIdentityDenied", reason: "sharedPhone" }));
  const action = (await app.state()).actions[app.action.key]!;
  assert.equal(action.status, "needsReview");
  assert.deepEqual(action.classMovement?.progress, progress);
  assert.equal(action.classMovement?.outcome, "needsReview");
  assert.equal(Object.hasOwn(action.classMovement!, "continuation"), false);
  assert.equal(action.classMovementConsent, undefined);
  success(await next.affirm());
  const denied = await app.state();
  assert.equal(denied.callerIdentityDenied, "sharedPhone");
  assert.equal(denied.actions[app.action.key]?.status, "needsReview");
  assert.equal(denied.effects[next.effectId], undefined, "later input cannot dispatch the retired stage");
  assert.equal(app.host.writes.length, 1);
});
