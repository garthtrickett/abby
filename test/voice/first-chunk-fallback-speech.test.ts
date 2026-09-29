import assert from "node:assert/strict";
import test from "node:test";
import { FirstChunkFallbackSpeech } from "../../src/voice/first-chunk-fallback-speech.ts";
import { StreamedPlaybackPort } from "../../src/voice/streamed-playback-port.ts";

test("E2E-151 stalled primary switches before output and only fallback audio can be marked played", async () => {
  const chosen: string[] = [];
  let primaryAborted = false;
  let fallbackCalls = 0;
  const fallbackAudio = new Uint8Array(640);
  new DataView(fallbackAudio.buffer).setInt16(0, 2_000, true);
  const synthesis = new FirstChunkFallbackSpeech({
    primaryFirstChunkMs: 100,
    primary: { async *stream(_text, signal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => {
        primaryAborted = true;
        resolve();
      }, { once: true }));
    } },
    fallback: { async *stream() { fallbackCalls += 1; yield fallbackAudio; } },
    onSelection: source => { chosen.push(source); },
  });
  const queued: Uint8Array[] = [];
  let lastSequence = -1;
  const playback = new StreamedPlaybackPort(synthesis, {
    async queueChunk(_id, sequence, bytes) { assert.equal(sequence, queued.length);
      queued.push(new Uint8Array(bytes)); return "queued"; },
    async finishQueue(_id, sequence) { lastSequence = sequence; return "queued"; },
    async clear() { return true; },
  }, { stepDeadlineMs: 1_000, firstChunkDeadlineMs: 1_500 });
  assert.equal(await playback.enqueue("fallback:playback", "Approved greeting", () => true), "queued");
  assert.equal(primaryAborted, true);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(chosen, ["fallback"]);
  assert.deepEqual(queued, [fallbackAudio]);
  assert.equal(lastSequence, 0);
  assert.deepEqual(await playback.acceptCompletion({ playbackId: "fallback:playback", lastSequence: 0,
    status: "played" }, async () => true), { ok: true,
    value: { playbackId: "fallback:playback", lastSequence: 0, status: "played" } });
});

test("speech cannot switch provider after a primary chunk may have reached transport", async () => {
  let fallbackCalls = 0;
  let clears = 0;
  const synthesis = new FirstChunkFallbackSpeech({ primaryFirstChunkMs: 100,
    primary: { async *stream() { yield new Uint8Array(640); throw new Error("primary lost midstream"); } },
    fallback: { async *stream() { fallbackCalls += 1; yield new Uint8Array(640); } },
  });
  const playback = new StreamedPlaybackPort(synthesis, {
    async queueChunk() { return "queued"; }, async finishQueue() { return "queued"; },
    async clear() { clears += 1; return true; },
  });
  assert.equal(await playback.enqueue("midstream:playback", "Approved notice", () => true), "uncertain");
  assert.equal(fallbackCalls, 0);
  assert.equal(clears, 1);
  assert.deepEqual(await playback.acceptCompletion({ playbackId: "midstream:playback",
    lastSequence: 0, status: "played" }, async () => true),
  { ok: false, error: { kind: "playbackUnknown" } });
});

test("healthy primary keeps the alternate silent", async () => {
  let fallbackCalls = 0;
  const selected: string[] = [];
  const audio = new Uint8Array(640);
  const synthesis = new FirstChunkFallbackSpeech({ primaryFirstChunkMs: 100,
    primary: { async *stream() { yield audio; } },
    fallback: { async *stream() { fallbackCalls += 1; yield new Uint8Array(640); } },
    onSelection: source => { selected.push(source); },
  });
  const queued: Uint8Array[] = [];
  const playback = new StreamedPlaybackPort(synthesis, {
    async queueChunk(_id, _sequence, bytes) { queued.push(bytes); return "queued"; },
    async finishQueue() { return "queued"; },
    async clear() { return true; },
  }, { firstChunkDeadlineMs: 1_500 });
  assert.equal(await playback.enqueue("primary:playback", "Approved greeting", () => true), "queued");
  assert.deepEqual(selected, ["primary"]);
  assert.deepEqual(queued, [audio]);
  assert.equal(fallbackCalls, 0);
});

test("caller interruption cancels the primary without starting fallback", async () => {
  let entered!: () => void;
  const primaryEntered = new Promise<void>(resolve => { entered = resolve; });
  let fallbackCalls = 0;
  const synthesis = new FirstChunkFallbackSpeech({ primaryFirstChunkMs: 500,
    primary: { async *stream(_text, signal) { entered();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    } },
    fallback: { async *stream() { fallbackCalls += 1; yield new Uint8Array(640); } },
  });
  const playback = new StreamedPlaybackPort(synthesis, {
    async queueChunk() { throw new Error("no audio may reach output"); },
    async finishQueue() { throw new Error("no marker may reach output"); },
    async clear() { return true; },
  }, { stepDeadlineMs: 1_000, firstChunkDeadlineMs: 1_500 });
  const pending = playback.enqueue("interrupted:playback", "Approved greeting", () => true);
  await primaryEntered;
  assert.equal(await playback.clear("interrupted:playback"), true);
  assert.equal(await pending, "notSent");
  assert.equal(fallbackCalls, 0);
});
