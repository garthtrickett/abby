import assert from "node:assert/strict";
import test from "node:test";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { classLink } from "../support/class-attendance.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";

for (const fault of ["none", "expired", "permission"] as const)
test(`E2E-419 a staged wait preserves date-search routing without bypassing ${fault}`, async () => {
  const f = await classMoveCallFlowFixture(false, false, { full: true }, true), at = () => f.config.clock();
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
    assert.ok(f.steps.some(row => row.stage === "proposalWait"), "exercise the actual selection-wait route");
    if (fault === "expired") await f.pause(121);
    if (fault === "permission") f.permit(false);
    const turn = f.turn("date-correction", "Actually, Saturday");
    resultValue(await f.runtime.nonAffirmativeFinal(turn, (await f.state()).conversationRevision, at()));
    assert.equal((await f.state()).actions[first.key]!.status, "canceled");
    const intent = await f.flow.searchMenuIntent(turn);
    assert.deepEqual(intent, { kind: "reschedulingMenu", stage: "offers", from: "2026-10-10", to: "2026-10-10", window: null, correcting: true });
    if (intent?.kind !== "reschedulingMenu") throw new Error("date search required");
    const corrected = resultValue(await reception.readReschedulingMenu(f.scope, turn, "offers", intent.from, intent.to, at(), intent.correcting, intent.window));
    assert.match(corrected.callerMessages.at(-1)!, fault === "none" ? /Saturday 10 October/ : /request fresh options/i);
    assert.deepEqual(corrected.actions[first.key]!.mutation.request, originalRequest, "retained search metadata cannot renew or change the cancelled request");
    assert.equal(Object.keys(corrected.actions).length, 1); assert.equal(corrected.actions[first.key]!.status, "canceled");
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});
