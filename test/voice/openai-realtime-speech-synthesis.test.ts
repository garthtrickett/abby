import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { OpenAIRealtimeSpeechSynthesis } from "../../src/voice/openai-realtime-speech-synthesis.ts";
import { StreamedPlaybackPort } from "../../src/voice/streamed-playback-port.ts";
import { FirstChunkFallbackSpeech } from "../../src/voice/first-chunk-fallback-speech.ts";

const text = "The appointment is not confirmed. Please call on Thursday.";
function ramp(samples = 961): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(index * 10, index * 2);
  return pcm;
}
class Socket extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  terminated = false;
  sent: Record<string, any>[] = [];
  afterUpdate: (event: any) => void = event => this.event({ type: "session.updated", session: event.session });
  afterCreate: (event: any) => void = () => {};
  send(bytes: string): void {
    const event = JSON.parse(bytes);
    this.sent.push(event);
    queueMicrotask(() => {
      if (this.terminated) return;
      if (event.type === "session.update") this.afterUpdate(event);
      else this.afterCreate(event);
    });
  }
  event(value: object): void { this.emit("message", Buffer.from(JSON.stringify(value))); }
  terminate(): void { this.terminated = true; this.readyState = 3; this.emit("close"); }
}
function harness(deadlineMs = 1_000) {
  const sockets: Socket[] = [];
  const synthesis = new OpenAIRealtimeSpeechSynthesis({ apiKey: "synthetic-key", deadlineMs,
    socketFactory(url, headers) {
      assert.equal(url, "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini");
      assert.deepEqual(headers, { Authorization: "Bearer synthetic-key" });
      const socket = new Socket(); sockets.push(socket);
      queueMicrotask(() => socket.emit("open"));
      return socket;
    } });
  return { synthesis, sockets };
}
const output = { format: { type: "audio/pcm", rate: 24_000 }, voice: "coral" };
function events(transcript = text, pcm = ramp()): any[] {
  const fields = { response_id: "response-one", item_id: "item-one", output_index: 0, content_index: 0 };
  const item = { id: "item-one", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_audio", transcript }] };
  const response = { id: "response-one", status: "completed", conversation_id: null,
    output_modalities: ["audio"], audio: { output }, output: [item] };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", ...fields, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...fields, part: { type: "audio", transcript: "" } },
    { type: "response.output_audio_transcript.delta", ...fields, delta: transcript },
    // Arbitrary WebSocket audio boundaries must not reset resampling phase.
    { type: "response.output_audio.delta", ...fields, delta: pcm.subarray(0, 1).toString("base64") },
    { type: "response.output_audio.delta", ...fields, delta: pcm.subarray(1, 903).toString("base64") },
    { type: "response.output_audio.delta", ...fields, delta: pcm.subarray(903).toString("base64") },
    { type: "response.output_audio.done", ...fields },
    { type: "response.output_audio_transcript.done", ...fields, transcript },
    { type: "response.content_part.done", ...fields, part: { type: "audio", transcript } },
    { type: "response.output_item.done", ...fields, item },
    { type: "response.done", response },
  ];
}
async function waitForSocket(h: ReturnType<typeof harness>): Promise<Socket> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (h.sockets[0]?.sent.length === 2) return h.sockets[0];
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("synthetic session did not configure");
}
function outputSink() {
  const chunks: Uint8Array[] = [];
  let clears = 0, finishes = 0;
  return { chunks, get clears() { return clears; }, get finishes() { return finishes; }, port: {
    async queueChunk(_id: string, sequence: number, chunk: Uint8Array) {
      assert.equal(sequence, chunks.length); chunks.push(chunk); return "queued" as const;
    },
    async finishQueue() { finishes += 1; return "queued" as const; },
    async clear() { clears += 1; return true; },
  } };
}

test("E2E-128 replacement speech: no prefix plays before exact completed response; chunks retain interpolation and padding", async () => {
  const h = harness(), sink = outputSink(), playback = new StreamedPlaybackPort(h.synthesis, sink.port);
  const queued = playback.enqueue("approved", text, () => true);
  const socket = await waitForSocket(h);
  assert.equal(socket.sent[0]!.session.tools.length, 0);
  assert.equal(socket.sent[0]!.session.tool_choice, "none");
  assert.equal(socket.sent[0]!.session.audio.input.turn_detection, null);
  assert.equal(socket.sent[1]!.response.conversation, "none");
  assert.deepEqual(socket.sent[1]!.response.input, [{ type: "message", role: "user",
    content: [{ type: "input_text", text: JSON.stringify(text) }] }]);
  const sequence = events();
  sequence.slice(0, -1).forEach(event => socket.event(event));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sink.chunks.length, 0, "even an exact transcript cannot release audio before response completion");
  socket.event(sequence.at(-1)!);
  assert.equal(await queued, "queued");
  assert.ok(socket.terminated);
  assert.deepEqual(sink.chunks.map(x => x.length), [640, 640, 320]);
  const pcm = Buffer.concat(sink.chunks);
  for (let index = 0; index < 641; index += 1) assert.equal(pcm.readInt16LE(index * 2), index * 15);
  for (let offset = 641 * 2; offset < pcm.length; offset += 2) assert.equal(pcm.readInt16LE(offset), 0);
  assert.equal(sink.finishes, 1);
  // Generation completion is not evidence that the transport played the response.
  assert.deepEqual(await playback.acceptCompletion({ playbackId: "approved", lastSequence: 1, status: "played" },
    async () => true), { ok: false, error: { kind: "invalidPlaybackEvidence" } });
  assert.equal((await playback.acceptCompletion({ playbackId: "approved", lastSequence: 2, status: "played" },
    async () => true)).ok, true);
});

test("E2E-128 replacement speech: changed negation, date, fee, added preamble and shortened replies never reach output", async () => {
  for (const actual of [text.replace("not ", ""), text.replace("Thursday", "Tuesday"),
    "Sure. " + text, "The appointment is not confirmed."]) {
    const h = harness(), sink = outputSink();
    const pending = new StreamedPlaybackPort(h.synthesis, sink.port).enqueue("rejected", text, () => true);
    const socket = await waitForSocket(h); events(actual).forEach(e => socket.event(e));
    assert.equal(await pending, "notSent"); assert.equal(sink.chunks.length, 0); assert.equal(sink.finishes, 0);
    assert.ok(socket.terminated);
  }
  const h = harness(), sink = outputSink();
  const pending = new StreamedPlaybackPort(h.synthesis, sink.port).enqueue("fee", "The deposit is £120.", () => true);
  const socket = await waitForSocket(h); events("The deposit is $120.").forEach(e => socket.event(e));
  assert.equal(await pending, "notSent"); assert.equal(sink.chunks.length, 0);
});

test("E2E-128 replacement speech: wrong identity, incomplete or extra output, tool/text responses, and contradictory finals fail before playback", async () => {
  const defects: ((sequence: any[]) => void)[] = [
    s => { s[4].response_id = "other-response"; },
    s => { s[4].item_id = "other-item"; },
    s => { s[4].content_index = 1; },
    s => { s.at(-1).response.status = "incomplete"; },
    s => { s.at(-1).response.output.push({ type: "function_call" }); },
    s => { s[1].item.type = "function_call"; },
    s => { s[2].part.type = "text"; },
    s => { s.at(-1).response.output[0].content[0].transcript = "An altered result"; },
    s => { s.splice(7, 1); }, // Missing audio completion.
    s => { s.splice(8, 1); }, // Missing transcript completion.
    s => { s[4].delta = "%%%not-base64"; },
    s => { s[4].delta = "AB=="; }, // Noncanonical padding bits.
    s => { s.push(s[4]); s.splice(11, 0, s.pop()); }, // Audio after audio.done.
  ];
  for (const defect of defects) {
    const h = harness(), sink = outputSink();
    const pending = new StreamedPlaybackPort(h.synthesis, sink.port).enqueue("invalid", text, () => true);
    const socket = await waitForSocket(h), sequence = events(); defect(sequence);
    sequence.forEach(e => socket.event(e));
    assert.equal(await pending, "notSent"); assert.equal(sink.chunks.length, 0); assert.ok(socket.terminated);
  }
});

test("E2E-128 replacement speech: malformed, silent and oversized audio cannot complete a queue", async () => {
  for (const pcm of [ramp().subarray(0, 101), Buffer.alloc(480), Buffer.alloc(960_002, 1)]) {
    const h = harness(), sink = outputSink();
    const pending = new StreamedPlaybackPort(h.synthesis, sink.port).enqueue("invalid-audio", text, () => true);
    const socket = await waitForSocket(h); events(text, pcm).forEach(e => socket.event(e));
    assert.equal(await pending, "notSent"); assert.equal(sink.chunks.length, 0); assert.equal(sink.finishes, 0);
  }
});

test("E2E-128 replacement speech: stalled generation and provider error stop under a deadline without leaking provider details", async () => {
  const h = harness(50), signal = new AbortController();
  const pending = h.synthesis.stream(text, signal.signal)[Symbol.asyncIterator]().next();
  await waitForSocket(h);
  await assert.rejects(pending, error => error instanceof Error && error.message === "speech audio unavailable");
  assert.ok(h.sockets[0]!.terminated);
  const errorHarness = harness();
  const failed = errorHarness.synthesis.stream(text, signal.signal)[Symbol.asyncIterator]().next();
  const socket = await waitForSocket(errorHarness);
  socket.event({ type: "error", error: { message: "secret provider detail" } });
  await assert.rejects(failed, error => error instanceof Error && error.message === "speech audio unavailable");
});

test("E2E-128 replacement speech: invalid session acknowledgments never dispatch text for generation", async () => {
  for (const change of [(s: any) => { s.model = "other-model"; },
    (s: any) => { s.audio.output.format.rate = 16_000; }, (s: any) => { s.tools = [{ type: "function" }]; },
    (s: any) => { s.instructions = "Different instructions"; }, (s: any) => { s.audio.input.turn_detection = {}; }]) {
    const h = harness();
    const pending = h.synthesis.stream(text, new AbortController().signal)[Symbol.asyncIterator]().next();
    const socket = h.sockets[0]!;
    socket.afterUpdate = event => { change(event.session); socket.event({ type: "session.updated", session: event.session }); };
    await assert.rejects(pending, /speech audio unavailable/);
    assert.equal(socket.sent.length, 1); assert.ok(socket.terminated);
  }
});

test("E2E-128 replacement speech: interruption discards buffered audio and ignores a later provider completion", async () => {
  const h = harness(), sink = outputSink(), playback = new StreamedPlaybackPort(h.synthesis, sink.port);
  const pending = playback.enqueue("interrupted", text, () => true);
  const socket = await waitForSocket(h); events().slice(0, 7).forEach(e => socket.event(e));
  assert.equal(await playback.clear("interrupted"), true);
  assert.equal(await pending, "notSent");
  events().slice(7).forEach(e => socket.event(e));
  assert.equal(sink.chunks.length, 0); assert.equal(sink.finishes, 0); assert.ok(socket.terminated);
});

test("E2E-128 replacement speech: pre-audio fallback aborts the rejected generation; no late primary audio can escape", async () => {
  const h = harness(), sink = outputSink(); let fallbackCalls = 0;
  const fallback = { async *stream() { fallbackCalls += 1; yield new Uint8Array(640).fill(1); } };
  const combined = new FirstChunkFallbackSpeech({ primary: h.synthesis, fallback, primaryFirstChunkMs: 50 });
  const pending = new StreamedPlaybackPort(combined, sink.port).enqueue("fallback", text, () => true);
  const socket = await waitForSocket(h);
  assert.equal(await pending, "queued"); assert.equal(fallbackCalls, 1); assert.ok(socket.terminated);
  events().forEach(e => socket.event(e));
  assert.equal(sink.chunks.length, 1); assert.equal(sink.chunks[0]![0], 1);
});

test("replacement speech: cancellation after the first validated chunk stops further release and streams remain isolated", async () => {
  const h = harness(), abort = new AbortController();
  const iterator = h.synthesis.stream(text, abort.signal)[Symbol.asyncIterator]();
  const first = iterator.next(), socket = await waitForSocket(h); events().forEach(e => socket.event(e));
  assert.equal((await first).value.length, 640);
  abort.abort(); await assert.rejects(iterator.next(), /speech audio unavailable/);
  const second = h.synthesis.stream(text, new AbortController().signal)[Symbol.asyncIterator]();
  const pending = second.next();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sockets.length, 2); assert.equal(h.sockets[1]!.sent.length, 2);
  events().forEach(e => h.sockets[1]!.event(e));
  assert.equal((await pending).value.length, 640); await second.return!();
  assert.ok(h.sockets[1]!.terminated);
});
