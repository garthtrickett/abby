// E2E-423: bounded contact-only terminal public-ASR drain; complete no-stop and real acoustic acceptance remain open.
import assert from "node:assert/strict";
import test from "node:test";
import { ok, err } from "../../src/core/model.ts";
import { OutboundTerminalTranscription } from "../../src/voice/outbound-terminal-transcription.ts";
import type { MediaFrame, TranscriptionPort } from "../../src/voice/media-turn-controller.ts";
import type { FinalCallerTurn } from "../../src/core/model.ts";
import { clearOutboundStopPhrase } from "../../src/standalone/twilio-outbound-stop-speech.ts";

function fixture(options: { raw?: Partial<TranscriptionPort>; deadline?: number; retentionDeadline?: number } = {}) {
  const state = { current: true };
  const calls = { accept: 0, flush: 0, close: 0, cancel: 0 }, observed: FinalCallerTurn[] = [], retained: FinalCallerTurn[] = [];
  const frames: MediaFrame[] = [0, 1].map(sequence => ({ sessionId: "session", sequence, capturedAt: `2026-11-02T00:00:00.0${sequence * 2}0Z`, bytes: new Uint8Array(640) }));
  const event = (generation: number, extra = {}) => ({ kind: "segmentFinal" as const, sessionId: "session", generation, utteranceId: "one", text: "Please stop calling me.", quality: "clear" as const, ...extra });
  const raw: TranscriptionPort = {
    accept: async (...args) => { calls.accept++; return options.raw?.accept?.(...args) ?? ok([]); },
    flush: async (...args) => { calls.flush++; return options.raw?.flush?.(...args) ?? ok([event(args[0])]); },
    cancel: async (...args) => { calls.cancel++; await options.raw?.cancel?.(...args); },
    close: async () => { calls.close++; await options.raw?.close?.(); },
  };
  const owner = new OutboundTerminalTranscription(raw, { callId: "call", sessionId: "session", deadlineMs: options.deadline ?? 100,
    now: () => "2026-11-02T00:00:01.000Z", policy: () => !state.current ? undefined : ({ retentionDeadlineMs: options.retentionDeadline ?? 100,
      inspect: turn => { observed.push(turn); if (turn.quality !== "clear") throw Error("uncertain"); return clearOutboundStopPhrase(turn.text) ? "stop" : "continue"; },
      retainStop: async turn => { retained.push(turn); } }) });
  const caller = new AbortController();
  return { state, owner, calls, observed, retained, frames, event, caller,
    accept: async () => { for (const frame of frames) assert.equal((await owner.transcription.accept(frame, 1, caller.signal)).ok, true); } };
}

test("terminal public tail flushes once after clinical abort and supplies only its bound positive policy", async () => {
  const f = fixture(); await f.accept(); assert.equal(f.calls.flush, 0);
  const finished = f.owner.finish(); f.caller.abort(); assert.equal(f.owner.finish(), finished); await finished;
  assert.equal(f.calls.flush, 1); assert.equal(f.retained.length, 1);
  assert.equal(f.retained[0]!.callId, "call"); assert.equal(f.retained[0]!.sessionId, "session");
  assert.match(f.retained[0]!.turnId, /^outbound-terminal:/);
  assert.equal((await f.owner.transcription.accept(f.frames[0]!, 2, new AbortController().signal)).ok, false);
  await Promise.all([f.owner.transcription.close?.(), f.owner.transcription.close?.()]);
  assert.equal(f.calls.close, 1); assert.equal(f.calls.flush, 1); assert.equal(f.retained.length, 1);
});

test("terminal drain joins the actual held flush without a second request or a late clinical result", async () => {
  let release!: () => void, entered!: () => void, actualSignal!: AbortSignal;
  const held = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ raw: { flush: async (generation, signal) => { actualSignal = signal; entered(); await held; return ok([f.event(generation)]); } } });
  await f.accept(); const ordinary = f.owner.transcription.flush(1, f.caller.signal); await begun;
  const terminal = f.owner.finish(); f.caller.abort(); assert.equal((await ordinary).ok, false); assert.equal(actualSignal.aborted, false);
  release(); await terminal; assert.equal(f.calls.flush, 1); assert.equal(f.retained.length, 1);
});

test("pending actual accept remains independently bounded while the clinical caller is immediately rejected", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ raw: { accept: async () => { entered(); await held; return ok([]); } } });
  const ordinary = f.owner.transcription.accept(f.frames[0]!, 1, f.caller.signal); await begun;
  const terminal = f.owner.finish(); f.caller.abort(); assert.equal((await ordinary).ok, false);
  release(); await terminal; assert.equal(f.retained.length, 1); assert.equal(f.calls.flush, 1);
});

test("ordinary cancellation before the deferred provider start never invokes that provider", async () => {
  const f = fixture(); const pending = f.owner.transcription.accept(f.frames[0]!, 1, f.caller.signal);
  f.caller.abort(); assert.equal((await pending).ok, false); await f.owner.finish();
  assert.equal(f.calls.accept, 0); assert.equal(f.calls.flush, 0); assert.equal(f.retained.length, 0);
});

test("ordinary cancellation of an actual held accept aborts the provider before terminal ownership can begin", async () => {
  let release!: () => void, entered!: () => void, signal!: AbortSignal;
  const held = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ raw: { accept: async (_frame, _generation, actual) => { signal = actual; entered(); await held; return ok([]); } } });
  const pending = f.owner.transcription.accept(f.frames[0]!, 1, f.caller.signal); await begun;
  f.caller.abort(); assert.equal((await pending).ok, false); assert.equal(signal.aborted, true);
  await f.owner.finish(); release(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.flush, 0); assert.equal(f.retained.length, 0);
});

test("explicit generation cancellation before terminal cannot revive that generation", async () => {
  const f = fixture(); await f.accept(); await f.owner.transcription.cancel?.(1);
  await f.owner.finish(); assert.equal(f.calls.flush, 0); assert.equal(f.retained.length, 0);
});

for (const fault of ["failure", "throws", "wrongSession", "wrongGeneration", "conflict", "partialOnly", "unresolvedTail", "oversize", "uncertain", "nonPositive"] as const)
test(`terminal ${fault} cannot fabricate native stop or complete no-stop evidence`, async () => {
  const f = fixture({ raw: { flush: async generation => {
    if (fault === "failure") return err({ kind: "transcriptionUnavailable" });
    if (fault === "throws") throw Error("synthetic provider failure");
    const e = f.event(generation);
    if (fault === "wrongSession") return ok([{ ...e, sessionId: "other" }]);
    if (fault === "wrongGeneration") return ok([{ ...e, generation: generation + 1 }]);
    if (fault === "conflict") return ok([e, { ...e, text: "Keep calling me" }]);
    if (fault === "partialOnly") return ok([{ kind: "partial", sessionId: "session", generation, utteranceId: "one", text: e.text }]);
    if (fault === "unresolvedTail") return ok([e, { kind: "partial", sessionId: "session", generation, utteranceId: "two", text: "Actually" }]);
    if (fault === "oversize") return ok([{ ...e, text: "x".repeat(513) }]);
    if (fault === "uncertain") return ok([{ ...e, quality: "needsClarification" }]);
    return ok([{ ...e, text: "Do not stop calling me" }]);
  } } });
  await f.accept(); assert.equal(await f.owner.finish(), undefined); assert.equal(f.retained.length, 0);
});

test("deadline seals a held raw tail; a late clear final cannot retain anything", async () => {
  let release!: () => void, entered!: () => void, signal!: AbortSignal;
  const held = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ deadline: 50, raw: { flush: async (generation, stop) => { signal = stop; entered(); await held; return ok([f.event(generation)]); } } });
  await f.accept(); const done = f.owner.finish(); await begun; await done; assert.equal(signal.aborted, true);
  release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.retained.length, 0); assert.equal(f.observed.length, 0);
  await f.owner.finish(); assert.equal(f.calls.flush, 1);
});

test("no admitted public ASR generation, including private-only audio, grants no terminal transcription or observation", async () => {
  const f = fixture(); await f.owner.finish(); assert.deepEqual(f.calls, { accept: 0, flush: 0, close: 0, cancel: 0 });
  assert.equal(f.observed.length, 0); assert.equal(f.retained.length, 0);
});

test("uncooperative raw close is bounded and repeated disposal shares one invocation", async () => {
  const f = fixture({ deadline: 50, raw: { close: () => new Promise<void>(() => undefined) } });
  await f.accept(); await f.owner.transcription.close?.(); await f.owner.transcription.close?.(); assert.equal(f.calls.close, 1);
});

for (const during of [false, true]) test(`conversation approval revoked ${during ? "during" : "before"} terminal ASR grants no stop observation`, async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { entered = resolve; });
  const f = fixture({ raw: { flush: async generation => { entered(); await held; return ok([f.event(generation)]); } } });
  await f.accept(); if (!during) f.state.current = false;
  const done = f.owner.finish();
  if (during) { await begun; f.state.current = false; release(); }
  await done; assert.equal(f.observed.length, 0); assert.equal(f.retained.length, 0); assert.equal(f.calls.flush, during ? 1 : 0);
});

for (const ordinary of [false, true]) test(`validated public queue ${ordinary ? "deduplicates ordinary admission" : "survives a wire stop before ordinary admission"}`, async () => {
  const seen: number[] = [];
  const f = fixture({ raw: { accept: async frame => { seen.push(frame.sequence); return ok([]); } } });
  for (const frame of f.frames) f.owner.bufferPublicFrame(frame);
  if (ordinary) await f.accept(); await f.owner.finish();
  assert.deepEqual(seen, [0, 1]); assert.equal(f.calls.flush, 1); assert.equal(f.retained.length, 1);
});

test("a complete non-positive utterance cannot hide a separate queued terminal stop", async () => {
  const f = fixture({ raw: { flush: async generation => ok([f.event(generation, { text: generation === 1 ? "Could you help me" : "Please stop calling me." })]) } });
  await f.accept(); assert.equal((await f.owner.transcription.flush(1, f.caller.signal)).ok, true);
  for (const frame of f.frames) f.owner.bufferPublicFrame({ ...frame, sequence: frame.sequence + 2 });
  await f.owner.finish(); assert.equal(f.calls.flush, 2); assert.equal(f.retained.length, 1);
  assert.deepEqual(f.observed.map(t => t.text), ["Could you help me", "Please stop calling me."]);
});

for (const completedPositive of [false, true]) test(`a truncated public queue ${completedPositive ? "preserves an earlier completed positive" : "cannot be treated as complete speech"}`, async () => {
  const f = fixture();
  if (completedPositive) { await f.accept(); await f.owner.transcription.flush(1, f.caller.signal); }
  for (let sequence = 2; sequence < 67; sequence++) f.owner.bufferPublicFrame({ ...f.frames[0]!, sequence });
  await f.owner.finish(); assert.equal(f.retained.length, completedPositive ? 1 : 0);
  assert.equal(f.calls.flush, completedPositive ? 1 : 0);
});
