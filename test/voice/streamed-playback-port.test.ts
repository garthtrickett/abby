import assert from "node:assert/strict";
import test from "node:test";
import { StreamedPlaybackPort } from "../../src/voice/streamed-playback-port.ts";
import type { AudioOutputPort, SpeechSynthesisPort } from "../../src/voice/streamed-playback-port.ts";

const chunk = () => new Uint8Array(640);

test("streamed playback queues ordered copied PCM and requires exact final-chunk evidence", async () => {
  const original = chunk();
  original[0] = 7;
  const sent: Array<{ sequence: number; bytes: Uint8Array }> = [];
  let finalSequence = -1;
  const synthesis: SpeechSynthesisPort = { async *stream() { yield original; yield chunk(); } };
  const output: AudioOutputPort = {
    async queueChunk(_id, sequence, bytes) { sent.push({ sequence, bytes }); return "queued"; },
    async finishQueue(_id, sequence) { finalSequence = sequence; return "queued"; },
    async clear() { return true; },
  };
  const playback = new StreamedPlaybackPort(synthesis, output);
  assert.equal(await playback.enqueue("speech-1", "Approved words", () => true), "queued");
  original[0] = 9;
  assert.deepEqual(sent.map(item => item.sequence), [0, 1]);
  assert.equal(sent[0]?.bytes[0], 7);
  assert.equal(finalSequence, 1);
  let settled = 0;
  const invalid = await playback.acceptCompletion({ playbackId: "speech-1", lastSequence: 0, status: "played" },
    async () => { settled += 1; return true; });
  assert.ok(!invalid.ok);
  assert.equal(invalid.error.kind, "invalidPlaybackEvidence");
  assert.equal(settled, 0);
  const event = { playbackId: "speech-1", lastSequence: 1, status: "played" as const };
  const unavailable = await playback.acceptCompletion(event, async () => { settled += 1; return false; });
  assert.ok(!unavailable.ok);
  assert.equal(unavailable.error.kind, "settlementUnavailable");
  const changed = await playback.acceptCompletion({ ...event, status: "failed" }, async () => true);
  assert.ok(!changed.ok);
  assert.equal(changed.error.kind, "invalidPlaybackEvidence");
  assert.equal((await playback.acceptCompletion(event, async () => { settled += 1; return true; })).ok, true);
  assert.equal(settled, 2);
  const replay = await playback.acceptCompletion(event, async () => true);
  assert.ok(!replay.ok);
  assert.equal(replay.error.kind, "playbackUnknown");
});

test("a closed output gate clears partial audio and prevents another chunk", async () => {
  let gateOpen = true;
  const sent: number[] = [];
  const cleared: string[] = [];
  const playback = new StreamedPlaybackPort({ async *stream() { yield chunk(); yield chunk(); } }, {
    async queueChunk(id, sequence) { sent.push(sequence); gateOpen = false; return "queued"; },
    async finishQueue() { throw new Error("gate must stop the final marker"); },
    async clear(id) { cleared.push(id); return true; },
  });
  assert.equal(await playback.enqueue("speech-2", "Approved words", () => gateOpen), "uncertain");
  assert.deepEqual(sent, [0]);
  assert.deepEqual(cleared, ["speech-2"]);
});

test("explicit first-chunk refusal is not sent, while a stalled synthesis step is bounded", async () => {
  const refused = new StreamedPlaybackPort({ async *stream() { yield chunk(); } }, {
    async queueChunk() { return "notSent"; },
    async finishQueue() { throw new Error("no chunk was queued"); },
    async clear() { return true; },
  });
  assert.equal(await refused.enqueue("speech-3", "Approved words", () => true), "notSent");

  let aborted = false;
  const stalled = new StreamedPlaybackPort({
    stream(_text, signal) {
      return { [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<Uint8Array>>(resolve => {
          signal.addEventListener("abort", () => { aborted = true; resolve({ done: true, value: undefined }); },
            { once: true });
        }) };
      } };
    },
  }, {
    async queueChunk() { throw new Error("no chunk expected"); },
    async finishQueue() { throw new Error("no final marker expected"); },
    async clear() { return true; },
  }, { stepDeadlineMs: 50 });
  const startedAt = Date.now();
  assert.equal(await stalled.enqueue("speech-4", "Approved words", () => true), "notSent");
  assert.equal(aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("clear aborts in-flight synthesis and rejects a late completion", async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let aborted = false;
  const playback = new StreamedPlaybackPort({
    async *stream(_text, signal) {
      yield chunk();
      entered();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); },
        { once: true }));
      yield chunk();
    },
  }, {
    async queueChunk() { return "queued"; },
    async finishQueue() { throw new Error("cleared stream must not finish"); },
    async clear() { return true; },
  });
  const enqueuing = playback.enqueue("speech-5", "Approved words", () => true);
  await waiting;
  assert.equal(await playback.clear("speech-5"), true);
  assert.equal(await enqueuing, "uncertain");
  assert.equal(aborted, true);
  assert.equal(await playback.enqueue("speech-5", "Approved words", () => true), "uncertain");
  const late = await playback.acceptCompletion({ playbackId: "speech-5", lastSequence: 0, status: "played" },
    async () => true);
  assert.ok(!late.ok);
  assert.equal(late.error.kind, "playbackUnknown");
});

test("an unacknowledged chunk send times out as uncertain and asks transport to clear", async () => {
  let aborted = false;
  let cleared = 0;
  const playback = new StreamedPlaybackPort({ async *stream() { yield chunk(); } }, {
    async queueChunk(_id, _sequence, _bytes, signal) {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise<"queued">(() => {});
    },
    async finishQueue() { throw new Error("no final marker expected"); },
    async clear() { cleared += 1; return true; },
  }, { stepDeadlineMs: 50 });
  const startedAt = Date.now();
  assert.equal(await playback.enqueue("speech-6", "Approved words", () => true), "uncertain");
  assert.equal(aborted, true);
  assert.equal(cleared, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});
