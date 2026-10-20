import assert from "node:assert/strict";
import test from "node:test";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { classLink } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";

for (const fault of ["none", "ordinary", "expired", "permission", "sourceCancelled", "sourceChanged", "expiresDuringRead"] as const)
test(`E2E-419 a staged wait preserves date-search routing without bypassing ${fault}`, async () => {
  const f = await classMoveCallFlowFixture(false, false, fault === "ordinary" ? undefined : { full: true }, true), at = () => f.config.clock();
  try {
    const budget = f.config.cliniko.rateBudget;
    const binding = { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(f.native.config.apiKey), budget };
    const reader = resultValue(ClinikoPatientCandidateReader.create({ scope: f.scope, apiKey: f.native.config.apiKey,
      contactEmail: f.native.config.contactEmail, rateBudget: budget }, f.fetchPort, at));
    const original = f.sessionConfig.lookup.candidates;
    f.sessionConfig.lookup.candidates = declareClinikoRequestCost(async (...args: Parameters<typeof original>) => {
      assert.equal(resultValue(await reader.hasCurrentPhone(f.scope, "482746192837465", f.inbound.presentedCallerNumber!, "61")), true);
      return original(...args);
    }, binding, 1);
    f.native.groups.push({ ...structuredClone(f.native.groups[1]!), id: "95", ...classLink("group_appointments", "95"),
      starts_at: "2026-10-10T12:00:00.000Z", ends_at: "2026-10-10T13:00:00.000Z" });
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, at);
    resultValue(await reception.startWorkflow(f.scope, f.turn("start", "Move my Pilates class"), "reschedule", at(), undefined,
      new AbortController().signal, undefined, undefined, undefined, true));
    await f.play();
    const until = Date.now() + 5000;
    while (!f.mail.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    const first = await f.prepare(reception); await f.play();
    const originalRequest = structuredClone(first.mutation.request);
    if (fault !== "ordinary") assert.ok(f.steps.some(row => row.stage === "proposalWait"), "exercise the actual selection-wait route");
    if (fault === "expired") await f.pause(121);
    if (fault === "permission") f.permit(false);
    if (fault === "sourceCancelled") f.native.attendees.find(row => row.id === "101")!.cancelled_at = at();
    if (fault === "sourceChanged") f.native.groups.find(row => row.id === "91")!.starts_at = "2026-10-08T11:00:00.000Z";
    const turn = f.turn("date-correction", "Actually, Saturday");
    resultValue(await f.runtime.nonAffirmativeFinal(turn, (await f.state()).conversationRevision, at()));
    assert.equal((await f.state()).actions[first.key]!.status, "canceled");
    const intent = await f.flow.searchMenuIntent(turn);
    assert.deepEqual(intent, { kind: "reschedulingMenu", stage: "offers", from: "2026-10-10", to: "2026-10-10", window: null, correcting: true });
    if (intent?.kind !== "reschedulingMenu") throw new Error("date search required");
    if (fault === "expiresDuringRead") {
      let targets = 0;
      f.phasePermission(async phase => { if (phase === "targets" && ++targets === 2) await f.pause(61); return true; });
      const read = await f.flow.readReschedulingMenu({ scope: f.scope, callId: f.callId, sessionId: f.sessionId,
        policyVersion: f.flowConfig.policyVersion, turnId: turn.turnId, now: at(), signal: new AbortController().signal,
        stage: "offers", from: intent.from, to: intent.to, window: intent.window,
        correctingAppointmentRef: originalRequest.kind === "reschedule" ? originalRequest.target.appointmentRef : "" });
      assert.equal(read.ok, false, "an expired original selection cannot be revived by a delayed fresh inspection");
      const unchanged = await f.state(); assert.equal(unchanged.lifecycle, "active", "isolate selection expiry from session expiry");
      assert.equal(unchanged.actions[first.key]!.status, "canceled"); assert.deepEqual(unchanged.actions[first.key]!.mutation.request, originalRequest);
      assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0); return;
    }
    const corrected = resultValue(await reception.readReschedulingMenu(f.scope, turn, "offers", intent.from, intent.to, at(), intent.correcting, intent.window));
    assert.match(corrected.callerMessages.at(-1)!, (fault === "none" || fault === "ordinary") ? /Saturday 10 October/ : /request fresh options/i);
    assert.deepEqual(corrected.actions[first.key]!.mutation.request, originalRequest, "retained search metadata cannot renew or change the cancelled request");
    assert.equal(Object.keys(corrected.actions).length, 1); assert.equal(corrected.actions[first.key]!.status, "canceled");
    if (fault === "none" || fault === "ordinary") {
      await f.play();
      let prepared = resultValue(await reception.selectReschedulingMenu(f.scope, f.turn("corrected-choice", "one"), "offers", 1, at()));
      if (Object.keys(prepared.actions).length === 1) {
        const notice = prepared.presentations[prepared.pendingPresentationId!];
        const seconds = notice?.kind === "notice" ? notice.confirmationWaitSeconds : undefined;
        assert.ok(typeof seconds === "number" && seconds >= 1 && seconds <= 60,
          "a fresh date search can issue a separately bounded corrected choice after current original evidence");
        assert.equal(f.writes.length, 0);
        await f.play(); await f.pause(seconds + 1);
        assert.deepEqual(await f.flow.spokenMenuIntent("The first time please."), { kind: "reschedulingChoice", stage: "offers", choice: 1 });
        prepared = resultValue(await reception.selectReschedulingMenu(f.scope, f.turn("corrected-retry", "one"), "offers", 1, at()));
      } else assert.equal(fault, "ordinary", "the full pass case exercises a bounded corrected selection wait");
      const replacement = Object.values(prepared.actions).at(-1)!;
      assert.equal(replacement.status, "awaitingConfirmation"); assert.notEqual(replacement.key, first.key);
      assert.equal(replacement.mutation.request.kind, "reschedule");
      if (replacement.mutation.request.kind !== "reschedule") throw new Error("corrected move required");
      assert.equal(replacement.mutation.request.offer.startsAt, "2026-10-10T12:00:00.000Z");
      assert.deepEqual(prepared.actions[first.key]!.mutation.request, originalRequest);
    }
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});
