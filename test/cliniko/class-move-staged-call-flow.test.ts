import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { ClinikoPatientCandidateReader } from "../../src/cliniko/patients.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { declareClinikoRequestCost } from "../../src/cliniko/request-cost.ts";

test("admitted staged pass selection retains ordinal routing only after the bounded wait is played", async () => {
  const f = await classMoveCallFlowFixture(true, true, { differentCase: true, history: 999, rosterHistory: 201 }, true), at = () => f.config.clock();
  try {
    const binding = { scope: f.scope, credentialFingerprint: clinikoCredentialFingerprint(f.native.config.apiKey), budget: f.config.cliniko.rateBudget };
    const reader = resultValue(ClinikoPatientCandidateReader.create({ scope: f.scope, apiKey: f.native.config.apiKey,
      contactEmail: f.native.config.contactEmail, rateBudget: binding.budget }, f.fetchPort, at));
    const original = f.sessionConfig.lookup.candidates;
    f.sessionConfig.lookup.candidates = declareClinikoRequestCost(async (...args: Parameters<typeof original>) => {
      assert.equal(resultValue(await reader.hasCurrentPhone(f.scope, "482746192837465", f.inbound.presentedCallerNumber!, "61")), true);
      return original(...args);
    }, binding, 1);
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, at);
    const resolver = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
      fetch: async () => { throw new Error("explicit class workflow and played ordinal retry must use finite routing"); } });
    const start = f.turn("start", "Move my Pilates class"), intent = resultValue(await resolver(start));
    assert.ok(intent.kind === "workflow");
    resultValue(await reception.startWorkflow(f.scope, start, "reschedule", at(), undefined,
      new AbortController().signal, undefined, undefined, undefined, true, intent.classSelectionRef)); await f.play();
    const until = Date.now() + 5000;
    while (!f.mail.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    resultValue(await reception.readReschedulingMenu(f.scope, f.turn("targets"), "targets", "2026-10-08", "2026-10-08", at())); await f.play();
    resultValue(await reception.selectReschedulingMenu(f.scope, f.turn("target"), "targets", 1, at())); await f.play();
    resultValue(await reception.readReschedulingMenu(f.scope, f.turn("offers"), "offers", "2026-10-09", "2026-10-09", at())); await f.play();
    const wait = resultValue(await reception.selectReschedulingMenu(f.scope, f.turn("choose", "one"), "offers", 1, at()));
    assert.match(wait.callerMessages.at(-1)!, /wait about 60 seconds.*choose your option again/i);
    assert.deepEqual(await f.flow.spokenMenuIntent("The first time please."), { kind: "clarify", reason: "menuUnavailable" });
    await f.play(); await f.pause(61);
    assert.deepEqual(resultValue(await resolver(f.turn("retry-route", "The first time please."))), { kind: "reschedulingChoice", stage: "offers", choice: 1 });
    const state = resultValue(await reception.selectReschedulingMenu(f.scope, f.turn("retry-choice", "one"), "offers", 1, at()));
    assert.equal(Object.values(state.actions).at(-1)!.status, "awaitingConfirmation");
    assert.equal(f.writes.length, 0); assert.equal(f.recalls.length, 0);
  } finally { await f.close(); }
});

for (const pass of [false, true]) test(`E2E-419 admitted ${pass ? "pass" : "ordinary"} flow prepares only its private next stage and routes fresh codes separately`, async () => {
  const f = await classMoveCallFlowFixture(false, false, pass ? {} : undefined, true), signal = new AbortController().signal;
  const at = () => f.config.clock();
  try {
    const resolver = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
      fetch: async () => { throw new Error("explicit class continuation must use finite routing"); } });
    const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, at);
    resultValue(await reception.startWorkflow(f.scope, f.turn("start", "Move my Pilates class"), "reschedule", at(), undefined,
      signal, undefined, undefined, undefined, true));
    await f.play();
    const until = Date.now() + 5000;
    while (!f.mail.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    const initial = await f.prepare(reception); await f.play(); await f.pause(61);
    resultValue(await reception.affirm(f.scope, f.turn("initial-yes", "Yes"), initial.key, initial.digest, at()));
    resultValue(await reception.drain(f.scope, f.callId, at()));
    assert.equal((await f.state()).actions[initial.key]!.status, "pendingContinuation");
    for (const stage of pass ? ["original", "association", "associationInspection"] : ["original"]) {
      await f.play(); await f.pause(61);
      let turn = f.turn(`continue-${stage}`, "Continue my class move");
      assert.deepEqual(resultValue(await resolver(turn)), { kind: "continueClassMovement" });
      const before = f.writes.length;
      let state = resultValue(await reception.continueClassMovement(f.scope, turn));
      assert.ok(state.processedTurnIds.includes(turn.turnId)); assert.equal(f.writes.length, before);
      if (f.flow.verificationRequired) {
        assert.match(state.callerMessages.at(-1)!, /registered email again/);
        await f.play();
        const until = Date.now() + 5000;
        while (f.mail.length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
        assert.equal(f.mail.length, 2);
        assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, false);
        assert.equal(f.flow.verificationRequired, true, "a wrong code cannot reset the renewal route");
        assert.equal((await f.flow.submitCode(f.mail[1]!.code)).verified, true);
        assert.equal(f.flow.verificationRequired, false); assert.equal(f.writes.length, before);
        await f.pause(61); turn = f.turn(`verified-continue-${stage}`, "Continue my class move");
        state = resultValue(await reception.continueClassMovement(f.scope, turn));
      }
      const action = state.actions[initial.key]!;
      assert.equal(action.status, "awaitingConfirmation"); assert.equal(action.classMovementConsent?.evidence.continuation.stage, stage);
      assert.equal((await reception.affirm(f.scope, f.turn("unplayed-yes", "Yes"), action.key, action.classMovementConsent!.digest, at())).ok, false);
      await f.play();
      resultValue(await reception.affirm(f.scope, f.turn(`yes-${stage}`, "Yes"), action.key, action.classMovementConsent!.digest, at()));
      resultValue(await reception.drain(f.scope, f.callId, at()));
      assert.equal(f.writes.length, before + (stage === "associationInspection" ? 0 : 1));
    }
    assert.equal((await f.state()).actions[initial.key]!.status, "committed");
    assert.ok(f.windowClaims.every(count => count <= 180));
    await f.play(); assert.equal((await reception.continueClassMovement(f.scope, f.turn("again", "Continue my class move"))).ok, false);
  } finally { await f.close(); }
});
