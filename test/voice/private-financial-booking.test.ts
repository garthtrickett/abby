import assert from "node:assert/strict";
import test from "node:test";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { PrivateFinancialBookingInput } from "../../src/standalone/private-financial-booking-input.ts";
import type { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import { financialBookingFixture } from "../support/financial-booking.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";
import { verificationNow } from "../support/caller-verification.ts";
import { ok } from "../../src/core/model.ts";

const settled = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function inputFor(f: Awaited<ReturnType<typeof financialBookingFixture>>) {
  let media = 0, ordinaryKeys = 0;
  const owner = { get financialBookingInput() { return f.host.financial; } } as unknown as ClinikoCallFlow;
  const input = new PrivateFinancialBookingInput({ claim: () => true, start: () => true, blocked: () => false,
    accept: async () => { ordinaryKeys++; return "pending"; }, acceptMedia: async () => { media++; return "pending"; }, stop() {} }, () => owner);
  return { input, get media() { return media; }, get ordinaryKeys() { return ordinaryKeys; } };
}
async function select(f: Awaited<ReturnType<typeof financialBookingFixture>>) {
  const ref = await f.verify(); resultValue(await f.propose(ref, "private-financial-select"));
  const state = await f.state(), id = state.pendingPresentationId!;
  resultValue(await f.runtime.startPresentation(f.callId, id, f.sessionId, verificationNow));
  resultValue(await f.runtime.resolvePresentation(f.callId, id, "played", f.sessionId, verificationNow));
  return ref;
}
test("financial input discards media and rejects pre-play or queued quote-phase digits", async () => {
  const play = deferred<{ presentationRef: string; playedAt: string } | undefined>();
  const f = await financialBookingFixture({ play: () => play.promise }); const mux = inputFor(f);
  try {
    await select(f); assert.equal(mux.input.blocked(), true);
    const first = mux.input.captureDigit("1", false), earlySecond = mux.input.captureDigit("1", false);
    assert.ok(first && earlySecond); assert.equal(await mux.input.accept("1", first), "pending"); await settled();
    assert.equal(f.pending().inputAdmission(), undefined);
    assert.equal(mux.input.captureDigit("1", true), undefined);
    await mux.input.acceptMedia({} as never); assert.equal(mux.media, 0);
    play.resolve({ presentationRef: crypto.randomUUID(), playedAt: verificationNow }); await settled(); await settled();
    assert.equal(await mux.input.accept("1", earlySecond), "pending"); assert.equal(f.pending().readySelection, undefined);
    assert.equal(await mux.input.accept("1", Object.freeze({})), "pending"); assert.equal(f.pending().readySelection, undefined);
    const valid = mux.input.captureDigit("1", false); assert.ok(valid);
    assert.equal(await mux.input.accept("1", valid), "verified"); assert.ok(f.pending().readySelection);
    assert.equal(mux.ordinaryKeys, 0); assert.equal(mux.input.blocked(), false); assert.equal(f.posts, 0);
  } finally { mux.input.stop(); await f.close(); }
});
test("financial playback runs outside the semantic wire queue and an interrupted receipt grants no consent", async () => {
  const play = deferred<{ presentationRef: string; playedAt: string } | undefined>();
  const f = await financialBookingFixture({ play: () => play.promise }); const mux = inputFor(f);
  try {
    await select(f); const result = await mux.input.accept("1", mux.input.captureDigit("1", false));
    assert.equal(result, "pending"); assert.equal(f.posts, 0);
    play.resolve(undefined); await settled(); await settled(); assert.equal(f.pending().readySelection, undefined);
    assert.equal(await mux.input.accept("1", mux.input.captureDigit("1", false)), "pending"); assert.equal(f.posts, 0);
  } finally { mux.input.stop(); await f.close(); }
});
test("actual VoiceSession playback mark supplies the opaque financial receipt with no fee or recipient in SAM", async () => {
  let voice: VoiceSession | undefined;
  const dispatched = deferred<{ id: string; text: string }>();
  const f = await financialBookingFixture({ activate: false, play: async (text, signal, canPresent) => {
    const receipt = await voice!.presentPrivateFinancialBooking(text, signal, verificationNow, canPresent);
    return receipt ? { ...receipt, playedAt: verificationNow } : undefined;
  } });
  try {
    const original = await f.state(); assert.ok(original.policy.greeting);
    voice = new VoiceSession(f.callId, f.sessionId, f.scope, f.ledger, f.reception,
      { enqueue: async (id, text) => { dispatched.resolve({ id, text }); return "queued"; }, clear: async () => true },
      async () => ok({ kind: "clarify" }), undefined, () => 0, { greeting: original.policy.greeting });
    resultValue(await voice.attach(verificationNow));
    await select(f);
    let done = false; const presenting = f.play().then(r => { done = true; return r; });
    const sent = await Promise.race([dispatched.promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Private financial playback was not dispatched")), 5_000); timer.unref(); })]); assert.equal(done, false); assert.ok(sent.text.includes("GBP 50.00"));
    const during = await f.state(); assert.ok(!JSON.stringify(during).includes("financial-recipient")); assert.ok(!JSON.stringify(during).includes("GBP 50.00"));
    const privateNotice = Object.values(during.presentations).find(p => p.status === "started"); assert.ok(privateNotice?.kind === "notice");
    assert.equal(privateNotice.approvedText, "");
    resultValue(await voice.acceptPlaybackResult(sent.id, "played", verificationNow)); assert.equal(await presenting, "pending");
    assert.equal(f.pending().readySelection, undefined); await f.accept(); assert.ok(f.pending().readySelection);
    assert.equal(f.posts, 0);
  } finally { voice?.stopTransientWork(); await f.close(); }
});

test("financial authority withdrawal closes the actual per-chunk private playback gate", async () => {
  let voice: VoiceSession | undefined, canSend: (() => boolean) | undefined;
  const dispatched = deferred<string>();
  const f = await financialBookingFixture({ activate: false, play: async (text, signal, canPresent) => {
    const receipt = await voice!.presentPrivateFinancialBooking(text, signal, verificationNow, canPresent);
    return receipt ? { ...receipt, playedAt: verificationNow } : undefined;
  } });
  try {
    const original = await f.state(); assert.ok(original.policy.greeting);
    voice = new VoiceSession(f.callId, f.sessionId, f.scope, f.ledger, f.reception,
      { enqueue: async (id, _text, current) => { canSend = current; dispatched.resolve(id); return "queued"; }, clear: async () => true },
      async () => ok({ kind: "clarify" }), undefined, () => 0, { greeting: original.policy.greeting });
    resultValue(await voice.attach(verificationNow)); await select(f);
    const playing = f.play(), id = await dispatched.promise; assert.ok(canSend); assert.equal(canSend(), true);
    f.withdrawFinancial(); assert.equal(canSend(), false);
    resultValue(await voice.acceptPlaybackResult(id, "played", verificationNow)); assert.equal(await playing, "verified");
    assert.equal(f.pending().readySelection, undefined); assert.equal(f.posts, 0);
  } finally { voice?.stopTransientWork(); await f.close(); }
});
