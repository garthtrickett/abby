import assert from "node:assert/strict";
import test from "node:test";
import { classMoveFixture } from "../support/class-move.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { decodeClinikoReview } from "../../src/cliniko/review-request.ts";
import { randomUUID } from "node:crypto";
import type { ClassMovementConsent } from "../../src/core/class-movement-consent.ts";

for (const pass of [false, true]) test(`E2E-419 actual staged ${pass ? "pass" : "ordinary"} host needs distinct played SAM effects across quota windows`, async () => {
  const f = await classMoveFixture(false, false, pass ? {} : undefined, true);
  const signal = new AbortController().signal, at = () => f.config.clock();
  try {
    await f.verify(); const action = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), action.key, action.digest, at()));
    resultValue(await f.reception.drain(f.scope, f.callId, at()));
    let state = await f.state(), current = state.actions[action.key]!;
    assert.equal(current.status, "pendingContinuation", JSON.stringify({ current, claims: f.claims }));
    assert.equal(current.classMovement?.outcome, "pending");
    assert.equal(f.writes.length, 1); assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
    const initialQuote = structuredClone(action.mutation.request);
    for (const stage of pass ? ["original", "association"] : ["original"]) {
      await f.play(); await f.pause(61);
      let prepared = resultValue(await f.host.prepareClassMovementContinuation(action.key, signal));
      if (prepared.kind === "verificationRequired") {
        const until = Date.now() + 5000;
        while (f.mail.length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
        assert.equal(f.mail.length, 2);
        assert.deepEqual(await f.host.submitClassMovementCode(f.mail[1]!.code, signal), { verified: true });
        await f.pause(61);
        prepared = resultValue(await f.host.prepareClassMovementContinuation(action.key, signal));
      }
      assert.ok(prepared.kind === "ready"); assert.equal(prepared.evidence.continuation.stage, stage);
      const before = f.writes.length;
      resultValue(await f.runtime.prepareClassMovementConsent(f.callId, action.key, prepared.evidence, at(), prepared.expectedConversationRevision));
      state = await f.state(); current = state.actions[action.key]!;
      assert.equal(current.status, "awaitingConfirmation"); assert.equal(f.writes.length, before);
      const speech = state.presentations[current.presentationId]; assert.ok(speech?.kind === "speech");
      assert.match(speech.approvedText, /overall class move is not confirmed/);
      await f.play();
      resultValue(await f.runtime.acceptTurn(f.turn(`phase-${stage}`, "Yes"),
        { kind: "classMovementAffirm", actionKey: action.key, digest: current.classMovementConsent!.digest }, at()));
      assert.equal(f.writes.length, before, "affirmation only admits the exact phase effect");
      resultValue(await f.reception.drain(f.scope, f.callId, at()));
      current = (await f.state()).actions[action.key]!;
      assert.equal(f.writes.length, before + 1, JSON.stringify({ stage, current, claims: f.claims }));
    }
    assert.equal(current.status, "committed", JSON.stringify(current));
    assert.equal(current.classMovement?.outcome, "moved");
    assert.deepEqual(current.mutation.request, initialQuote, "fresh proof/terms never edit the original action");
    assert.equal(f.recalls.length, 1);
    const review = resultValue(decodeClinikoReview(f.recalls[0]!.notes)).request.operation;
    assert.ok(review.kind === "classMove" && review.quotaStaging);
    assert.ok(f.windowClaims.every(count => count <= 180), JSON.stringify(f.windowClaims));
    assert.equal((await f.host.prepareClassMovementContinuation(action.key, signal)).ok, false);
    assert.equal(Object.keys(f.host).includes("staged"), false);
  } finally { await f.close(); }
});

for (const pass of [false, true]) for (const boundary of ["unplayed", "foreignOwner", "permission", "review", "speech", "closed"] as const)
test(`E2E-419 staged ${pass ? "pass" : "ordinary"} host refuses ${boundary} before another native mutation`, async () => {
  const f = await classMoveFixture(false, false, pass ? {} : undefined, true), signal = new AbortController().signal;
  const at = () => f.config.clock();
  try {
    await f.verify(); const initial = await f.prepare(); await f.play(); await f.pause(61);
    resultValue(await f.reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, at()));
    resultValue(await f.reception.drain(f.scope, f.callId, at())); await f.play(); await f.pause(61);
    const prepared = resultValue(await f.host.prepareClassMovementContinuation(initial.key, signal)); assert.ok(prepared.kind === "ready");
    resultValue(await f.runtime.prepareClassMovementConsent(f.callId, initial.key, prepared.evidence, at(), prepared.expectedConversationRevision));
    let action = (await f.state()).actions[initial.key]!;
    const consent: ClassMovementConsent = { evidence: action.classMovementConsent!.evidence, digest: action.classMovementConsent!.digest };
    if (boundary !== "unplayed") await f.play();
    const turn = f.turn("phase-yes", "Yes"), interpretation = { kind: "classMovementAffirm" as const, actionKey: initial.key, digest: consent.digest };
    const accepted = await f.runtime.acceptTurn(turn, interpretation, at());
    if (boundary === "unplayed") assert.equal(accepted.ok, false);
    else resultValue(accepted);
    if (boundary === "foreignOwner") {
      resultValue(await f.runtime.markHostPossiblySent(f.callId, `${initial.key}:classStage:${consent.digest}`, at()));
      const forged = { ...consent, evidence: { ...consent.evidence,
        continuation: { ...consent.evidence.continuation, ref: `class-move-stage:${randomUUID()}` } } };
      assert.deepEqual(await f.host.continueClassMovement(initial.mutation, forged, at(), signal), { kind: "rejected", actionKey: initial.key });
    } else if (boundary === "unplayed") {
      assert.deepEqual(await f.host.continueClassMovement(initial.mutation, consent, at(), signal), { kind: "rejected", actionKey: initial.key });
    } else {
      if (boundary === "permission") f.permit(false);
      if (boundary === "review") f.recalls[0]!.updated_at = new Date(Date.parse(at()) + 1).toISOString();
      if (boundary === "speech") resultValue(await f.runtime.beginSpeech(f.callId, f.sessionId, at()));
      if (boundary === "closed") resultValue(await f.runtime.endCall(f.callId, f.sessionId, at()));
      resultValue(await f.reception.drain(f.scope, f.callId, at()));
      action = (await f.state()).actions[initial.key]!;
      assert.notEqual(action.status, "committed");
    }
    assert.equal(f.writes.length, 1, "only the already inspected replacement was sent");
    assert.equal(f.native.attendees.find(row => row.id === "101")!.cancelled_at, null);
    assert.equal(f.native.attendees.find(row => row.id === "401")!.cancelled_at, null);
    assert.ok(f.windowClaims.every(count => count <= 180));
  } finally { await f.close(); }
});
