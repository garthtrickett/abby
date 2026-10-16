import assert from "node:assert/strict";
import test from "node:test";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { createOpenAIClinicalIntentResolver } from "../../src/standalone/openai-clinical-intent.ts";
import { classMoveCallFlowFixture } from "../support/class-move-call-flow.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-419 actual voice session prepares and plays a new phase before its distinct affirmative effect", async () => {
  const f = await classMoveCallFlowFixture(false, false, undefined, true, false), at = () => f.config.clock();
  const reception = new TextReception(f.ledger, f.policies, f.flow, undefined, undefined, undefined, undefined, at);
  const queued: string[] = [];
  const voice = new VoiceSession(f.callId, f.sessionId, f.scope, f.ledger, reception,
    { enqueue: async (_id, text) => { queued.push(text); return "queued"; }, clear: async () => true },
    createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: "synthetic", model: "synthetic", clinicDate: () => "2026-10-04",
      fetch: async () => { throw new Error("continuation and yes use finite routing"); } }), undefined, () => Date.parse(at()));
  const advance = async (seconds: number) => {
    for (let left = seconds; left > 0; left -= 15) {
      f.setTime(new Date(Date.parse(at()) + Math.min(left, 15) * 1000).toISOString());
      resultValue(await voice.renew(at()));
    }
  };
  let ordinal = 0;
  const say = async (text: string) => {
    const generation = resultValue(await voice.speechStarted(at()));
    resultValue(voice.acceptTranscript({ kind: "segmentFinal", sessionId: f.sessionId, generation, utteranceId: `stage-${++ordinal}`, text, quality: "clear" }));
    return voice.finishTurn(at());
  };
  try {
    resultValue(await voice.attach(at()));
    resultValue(await reception.startWorkflow(f.scope, f.turn("start", "Move my Pilates class"), "reschedule", at(), undefined,
      new AbortController().signal, undefined, undefined, undefined, true)); await f.play();
    const until = Date.now() + 5000;
    while (!f.mail.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal((await f.flow.submitCode(f.mail[0]!.code)).verified, true);
    const action = await f.prepare(reception); await f.play(); await advance(61);
    resultValue(await reception.affirm(f.scope, f.turn("initial-yes", "Yes"), action.key, action.digest, at()));
    resultValue(await reception.drain(f.scope, f.callId, at())); await f.play(); await advance(61);
    resultValue(await say("Continue my class move"));
    assert.equal(f.writes.length, 1); assert.equal((await f.state()).actions[action.key]!.status, "awaitingConfirmation");
    const dispatched = resultValue(await voice.dispatchPending(at()));
    assert.equal(dispatched.kind, "queued"); assert.match(queued.at(-1)!, /separate confirmation to cancel the original/);
    if (dispatched.kind !== "queued") throw new Error("phase readback was not queued");
    assert.ok(dispatched.playbackId);
    resultValue(await voice.acceptPlaybackResult(dispatched.playbackId, "played", at()));
    resultValue(await say("Yes")); assert.equal(f.writes.length, 1);
    resultValue(await voice.drainEffects(at()));
    assert.equal(f.writes.length, 2); assert.equal((await f.state()).actions[action.key]!.status, "committed");
    assert.ok(f.windowClaims.every(count => count <= 180));
  } finally { await voice.end(at()); await f.close(); }
});
