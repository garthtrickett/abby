import assert from "node:assert/strict";
import test from "node:test";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

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
    for (const stage of pass ? ["original", "association"] : ["original"]) {
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
      assert.equal(f.writes.length, before + 1);
    }
    assert.equal((await f.state()).actions[initial.key]!.status, "committed");
    assert.ok(f.windowClaims.every(count => count <= 180));
    await f.play(); assert.equal((await reception.continueClassMovement(f.scope, f.turn("again", "Continue my class move"))).ok, false);
  } finally { await f.close(); }
});
