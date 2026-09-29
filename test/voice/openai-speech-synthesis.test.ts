import assert from "node:assert/strict";
import test from "node:test";
import { OpenAISpeechSynthesis } from "../../src/voice/openai-speech-synthesis.ts";
import { StreamedPlaybackPort } from "../../src/voice/streamed-playback-port.ts";

function pcmRamp(samples: number): Uint8Array {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, index * 10, true);
  return bytes;
}

function audioResponse(bytes: Uint8Array, slices: readonly number[] = [bytes.length]): Response {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (const size of slices) {
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    }
    if (offset < bytes.length) controller.enqueue(bytes.slice(offset));
    controller.close();
  } }), { status: 200, headers: { "Content-Type": "audio/pcm" } });
}

test("E2E-128 synthetic voice: provider PCM streams through Abby playback and only transport completion proves played", async () => {
  const spoken = "The clinic opens at nine.";
  const requests: unknown[] = [];
  const fetchPort: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/audio/speech");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-key");
    requests.push(JSON.parse(String(init?.body)));
    return audioResponse(pcmRamp(480), [1, 2, 137, 600, 220]);
  };
  const synthesis = new OpenAISpeechSynthesis({ apiKey: "synthetic-key", fetchPort });
  const queued: Uint8Array[] = [];
  let finalSequence = -1;
  const playback = new StreamedPlaybackPort(synthesis, {
    async queueChunk(_id, sequence, bytes) {
      assert.equal(sequence, queued.length);
      queued.push(new Uint8Array(bytes));
      return "queued";
    },
    async finishQueue(_id, sequence) { finalSequence = sequence; return "queued"; },
    async clear() { return true; },
  });
  assert.equal(await playback.enqueue("notice:playback", spoken, () => true), "queued");
  assert.deepEqual(requests, [{ model: "gpt-4o-mini-tts", voice: "coral", input: spoken,
    response_format: "pcm", stream_format: "audio" }]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.byteLength, 640);
  const view = new DataView(queued[0]!.buffer);
  assert.deepEqual([0, 1, 2, 3].map(index => view.getInt16(index * 2, true)), [0, 15, 30, 45]);
  assert.equal(finalSequence, 0);
  let settled = 0;
  assert.deepEqual(await playback.acceptCompletion({ playbackId: "notice:playback", lastSequence: 0,
    status: "played" }, async () => { settled += 1; return true; }),
  { ok: true, value: { playbackId: "notice:playback", lastSequence: 0, status: "played" } });
  assert.equal(settled, 1);
});

test("E2E-128 synthetic voice: provider failure, malformed audio, and cancellation never produce played evidence", async () => {
  const denied = new OpenAISpeechSynthesis({ apiKey: "synthetic-key",
    fetchPort: async () => Response.json({ error: "private provider detail" }, { status: 401 }) });
  const sent: Uint8Array[] = [];
  const output = {
    async queueChunk(_id: string, _sequence: number, bytes: Uint8Array) { sent.push(bytes); return "queued" as const; },
    async finishQueue() { return "queued" as const; },
    async clear() { return true; },
  };
  const deniedPlayback = new StreamedPlaybackPort(denied, output);
  assert.equal(await deniedPlayback.enqueue("denied:playback", "Approved reply", () => true), "notSent");
  assert.deepEqual(sent, []);
  assert.deepEqual(await deniedPlayback.acceptCompletion({ playbackId: "denied:playback", lastSequence: 0,
    status: "played" }, async () => true), { ok: false, error: { kind: "playbackUnknown" } });

  const malformed = new OpenAISpeechSynthesis({ apiKey: "synthetic-key",
    fetchPort: async () => audioResponse(new Uint8Array([1, 2, 3])) });
  assert.equal(await new StreamedPlaybackPort(malformed, output)
    .enqueue("bad:playback", "Approved reply", () => true), "notSent");
  assert.deepEqual(sent, []);
  const truncated = new OpenAISpeechSynthesis({ apiKey: "synthetic-key",
    fetchPort: async () => audioResponse(new Uint8Array([1, 2])) });
  assert.equal(await new StreamedPlaybackPort(truncated, output)
    .enqueue("truncated:playback", "Approved reply", () => true), "notSent");
  assert.deepEqual(sent, []);

  let clears = 0;
  const partial = new OpenAISpeechSynthesis({ apiKey: "synthetic-key",
    fetchPort: async () => audioResponse(new Uint8Array([...pcmRamp(480), 9])) });
  const partialPlayback = new StreamedPlaybackPort(partial, {
    ...output, async clear() { clears += 1; return true; },
  });
  assert.equal(await partialPlayback.enqueue("partial:playback", "Approved reply", () => true), "uncertain");
  assert.equal(sent.length, 1);
  assert.equal(clears, 1);
  assert.deepEqual(await partialPlayback.acceptCompletion({ playbackId: "partial:playback", lastSequence: 0,
    status: "played" }, async () => true), { ok: false, error: { kind: "playbackUnknown" } });

  const controller = new AbortController();
  const canceled = new OpenAISpeechSynthesis({ apiKey: "synthetic-key",
    fetchPort: async () => audioResponse(pcmRamp(960), [960]) });
  const iterator = canceled.stream("Approved reply", controller.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.byteLength, 640);
  controller.abort();
  await assert.rejects(iterator.next(), /speech audio unavailable/);
});
