import assert from "node:assert/strict";
import test from "node:test";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { classLink } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";

for (const fault of ["none", "expiredQuote", "permission", "unavailableBudget", "invalidWait"] as const)
test(`E2E-419 corrected cross-case first-stage wait preserves proof and played consent under ${fault}`, async () => {
  const f = await classMoveCallFlowFixture(true, false, { differentCase: true }, true), at = () => f.config.clock();
  try {
    const binding = { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(f.native.config.apiKey), budget: f.config.cliniko.rateBudget };
    const reader = resultValue(ClinikoPatientCandidateReader.create({ scope: f.scope, apiKey: f.native.config.apiKey,
      contactEmail: f.native.config.contactEmail, rateBudget: binding.budget }, f.fetchPort, at));
    const original = f.sessionConfig.lookup.candidates;
    f.sessionConfig.lookup.candidates = declareClinikoRequestCost(async (...args: Parameters<typeof original>) => {
      assert.equal(resultValue(await reader.hasCurrentPhone(f.scope, "482746192837465", f.inbound.presentedCallerNumber!, "61")), true);
      return original(...args);
    }, binding, 1);
    f.native.groups.push({ ...structuredClone(f.native.groups[1]!), id: "95", ...classLink("group_appointments", "95"),
      starts_at: "2026-10-10T12:00:00.000Z", ends_at: "2026-10-10T12:30:00.000Z" });
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, at);
    resultValue(await reception.startWorkflow(f.scope, f.turn("start", "Move my Pilates class"), "reschedule", at(), undefined,
      new AbortController().signal, undefined, undefined, undefined, true)); await f.play();
    const until = Date.now() + 5000;
    while (!f.mail.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    const first = await f.prepare(reception); await f.play();
    const turn = f.turn("date", "Actually, Saturday");
    resultValue(await f.runtime.nonAffirmativeFinal(turn, (await f.state()).conversationRevision, at()));
    resultValue(await reception.readReschedulingMenu(f.scope, turn, "offers", "2026-10-10", "2026-10-10", at(), true)); await f.play();
    let prepared = resultValue(await reception.selectReschedulingMenu(f.scope, f.turn("choose", "one"), "offers", 1, at()));
    const notice = prepared.presentations[prepared.pendingPresentationId!];
    assert.ok(notice?.kind === "notice" && notice.confirmationWaitSeconds);
    await f.play(); await f.pause(notice.confirmationWaitSeconds + 1);
    prepared = resultValue(await reception.selectReschedulingMenu(f.scope, f.turn("choose-again", "one"), "offers", 1, at()));
    const selected = Object.values(prepared.actions).at(-1)!, request = structuredClone(selected.mutation.request);
    assert.equal(selected.status, "awaitingConfirmation"); assert.notEqual(selected.key, first.key); await f.play();
    if (fault === "unavailableBudget" || fault === "invalidWait") {
      Object.assign(f.config.cliniko.rateBudget, { checkHeadroom: async () => fault === "unavailableBudget"
        ? { kind: "unavailable" } : { kind: "rateLimited", retryAfterMs: 61000 } });
      resultValue(await reception.affirm(f.scope, f.turn("unavailable-yes", "Yes"), selected.key, selected.digest, at()));
      resultValue(await reception.drain(f.scope, f.callId, at()));
      assert.equal((await f.state()).actions[selected.key]!.status, "canceled");
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0); return;
    }
    resultValue(await reception.affirm(f.scope, f.turn("initial-yes", "Yes"), selected.key, selected.digest, at()));
    resultValue(await reception.drain(f.scope, f.callId, at()));
    const pending = (await f.state()).actions[selected.key]!;
    assert.equal(pending.status, "pendingContinuation", "native stage owns a quota pause before any replacement send");
    assert.equal(pending.classMovement?.outcome, "pending");
    assert.equal(pending.classMovement?.outcome === "pending" ? pending.classMovement.continuation.stage : undefined, "replacement");
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0); await f.play();
    assert.equal((await reception.affirm(f.scope, f.turn("old-yes", "Yes"), selected.key, selected.digest, at())).ok, false);
    let continuation = resultValue(await reception.continueClassMovement(f.scope, f.turn("continue", "Continue my class move")));
    assert.match(continuation.callerMessages.at(-1)!, /wait about 60 seconds.*ask to continue/); await f.play(); await f.pause(61);
    continuation = resultValue(await reception.continueClassMovement(f.scope, f.turn("after-wait", "Continue my class move")));
    assert.equal(f.flow.verificationRequired, true); assert.match(continuation.callerMessages.at(-1)!, /registered email again/); await f.play();
    const mailUntil = Date.now() + 5000;
    while (f.mail.length < 2 && Date.now() < mailUntil) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.mail.length, 2); assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, false);
    assert.equal((await f.flow.submitCode(f.mail[1]!.code)).verified, true); assert.equal(f.writes.length, 0);
    if (fault === "expiredQuote") await f.pause(61);
    if (fault === "permission") f.permit(false);
    const resumed = await reception.continueClassMovement(f.scope, f.turn("fresh-proof", "Continue my class move"));
    if (fault === "expiredQuote" || fault === "permission") {
      assert.equal(resumed.ok, false);
      if (!resumed.ok) assert.equal(resumed.error.kind, "effectFailure");
      const next = (await f.state()).actions[selected.key]!;
      assert.notEqual(next.status, "awaitingConfirmation"); assert.equal(next.classMovementConsent, undefined);
      assert.deepEqual(next.mutation.request, request); assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0); return;
    }
    const next = resultValue(resumed).actions[selected.key]!;
    assert.equal(next.status, "awaitingConfirmation"); assert.equal(next.classMovementConsent?.evidence.continuation.stage, "replacement");
    assert.deepEqual(next.mutation.request, request, "old request and its quote are immutable through proof renewal");
    assert.equal((await reception.affirm(f.scope, f.turn("unplayed-yes", "Yes"), next.key, next.classMovementConsent!.digest, at())).ok, false);
    await f.play(); resultValue(await reception.affirm(f.scope, f.turn("fresh-yes", "Yes"), next.key, next.classMovementConsent!.digest, at()));
    resultValue(await reception.drain(f.scope, f.callId, at()));
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.body.booking_id, "95"); assert.equal(f.recalls.length, 1);
    assert.equal((await f.state()).actions[first.key]!.status, "canceled");
  } finally { await f.close(); }
});
