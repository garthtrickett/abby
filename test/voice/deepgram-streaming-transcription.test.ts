import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { ok } from "../../src/core/model.ts";
import { DeepgramStreamingTranscription } from "../../src/voice/deepgram-streaming-transcription.ts";
import { MediaTurnController } from "../../src/voice/media-turn-controller.ts";
import type { MediaFrame } from "../../src/voice/media-turn-controller.ts";
import { TurnAssembler } from "../../src/voice/turn-assembler.ts";

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  terminated = 0;
  open(): void { this.readyState = WebSocket.OPEN; this.emit("open"); }
  receive(value: object): void { this.emit("message", Buffer.from(JSON.stringify(value)), false); }
  send(value: string | Buffer): void { this.sent.push(value); }
  end(code = 1000): void { this.readyState = WebSocket.CLOSED; this.emit("close", code); }
  terminate(): void { this.terminated++; this.end(1006); }
}
const frame = (sequence = 0): MediaFrame => ({ sessionId: "session", sequence,
  capturedAt: new Date(Date.parse("2026-10-23T00:00:00.000Z") + sequence * 20).toISOString(),
  bytes: new Uint8Array(640).fill(12) });
const signal = () => new AbortController().signal;
const result = (text = "Book an appointment", start = 0, duration = 0.02, is_final = true) => ({
  type: "Results", channel_index: [0, 1], start, duration, is_final, speech_final: true,
  channel: { alternatives: [{ transcript: text, confidence: 1 }] },
});
function fixture() {
  const sockets: FakeSocket[] = [];
  const port = new DeepgramStreamingTranscription({ apiKey: "synthetic-key", sessionId: "session",
    socketFactory: (raw, headers) => {
      const url = new URL(raw);
      assert.equal(url.origin, "wss://api.deepgram.com"); assert.equal(url.pathname, "/v1/listen");
      assert.equal(url.searchParams.get("model"), "nova-3");
      assert.equal(url.searchParams.get("encoding"), "linear16");
      assert.equal(url.searchParams.get("sample_rate"), "16000");
      assert.equal(url.searchParams.get("endpointing"), "false");
      assert.equal(url.searchParams.get("mip_opt_out"), "true");
      assert.equal(url.searchParams.has("keyterm"), false);
      assert.deepEqual(headers, { Authorization: "Token synthetic-key" });
      const socket = new FakeSocket(); sockets.push(socket); queueMicrotask(() => socket.open());
      return socket as unknown as WebSocket;
    } });
  return { port, sockets };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("Deepgram concurrent flush or late audio cannot overwrite the pending owner", async () => {
  const { port, sockets } = fixture(); assert.ok((await port.accept(frame(), 1, signal())).ok);
  const pending = port.flush(1, signal()), other = port.flush(1, signal());
  const late = port.accept(frame(1), 1, signal()); await tick();
  assert.equal((await other).ok, false); assert.equal((await late).ok, false);
  const socket = sockets[0]!; assert.equal(socket.sent.length, 2);
  socket.receive(result()); socket.receive({ type: "Metadata", channels: 1, duration: 0.02 }); socket.end();
  assert.ok((await pending).ok); await port.close();
});

for (const phase of ["connect", "flush"] as const) {
  test(`Deepgram ${phase} has its own bounded deadline without caller abort`, { timeout: 8_000 }, async () => {
    const socket = new FakeSocket();
    const port = new DeepgramStreamingTranscription({ apiKey: "synthetic-key", sessionId: "session",
      socketFactory: () => socket as unknown as WebSocket });
    const accepted = port.accept(frame(), 1, signal());
    if (phase === "flush") { socket.open(); assert.ok((await accepted).ok); }
    assert.equal((await (phase === "connect" ? accepted : port.flush(1, signal()))).ok, false);
    assert.equal(socket.terminated, 1); await port.close();
  });
}

test("Deepgram streams unchanged PCM and waits for final segments, whole-turn summary and normal close", async () => {
  const { port, sockets } = fixture();
  const input = frame(); assert.ok((await port.accept(input, 1, signal())).ok);
  const socket = sockets[0]!;
  assert.deepEqual(socket.sent[0], Buffer.from(input.bytes)); input.bytes.fill(99);
  assert.equal((socket.sent[0] as Buffer)[0], 12, "borrowed media cannot mutate the queued payload");
  socket.receive(result("Book", 0, 0.01));
  const pending = port.flush(1, signal()); await tick();
  assert.equal(socket.sent[1], '{"type":"CloseStream"}');
  let settled = false; void pending.then(() => { settled = true; });
  socket.receive(result("an appointment", 0.01, 0.01)); await tick(); assert.equal(settled, false);
  socket.receive({ type: "Metadata", channels: 1, duration: 0.02 }); await tick(); assert.equal(settled, false);
  socket.end(); const final = await pending;
  assert.ok(final.ok); if (!final.ok) return;
  assert.equal(final.value.length, 1); assert.equal(final.value[0]?.kind, "segmentFinal");
  assert.deepEqual(final.value[0], { kind: "segmentFinal", sessionId: "session", generation: 1,
    utteranceId: final.value[0]!.utteranceId, text: "Book an appointment", quality: "needsClarification" });
  await port.close();
});

test("Deepgram keeps later generations on separate streams and ignores retired socket messages", async () => {
  const { port, sockets } = fixture();
  for (const generation of [1, 2]) {
    assert.ok((await port.accept(frame(), generation, signal())).ok);
    const socket = sockets.at(-1)!;
    if (generation === 2) {
      sockets[0]!.receive(result("stale patient")); sockets[0]!.emit("error", new Error("old socket"));
      await port.cancel(1);
      assert.equal((await port.flush(1, signal())).ok, false);
    }
    const pending = port.flush(generation, signal()); await tick();
    socket.receive(result()); socket.receive({ type: "Metadata", channels: 1, duration: 0.02 }); socket.end();
    const final = await pending; assert.ok(final.ok);
    if (final.ok) assert.equal(final.value[0]?.generation, generation);
  }
  assert.equal(sockets.length, 2);
  assert.equal((await port.accept(frame(), 2, signal())).ok, false, "settled generation cannot replay");
  await port.close();
});

for (const variant of ["noSummary", "abnormalClose", "shortSummary", "wrongChannel", "overlap", "interimOnly"] as const) {
  test(`Deepgram refuses incomplete or invalid turn closure: ${variant}`, async () => {
    const { port, sockets } = fixture();
    const count = variant === "shortSummary" ? 20 : 1;
    for (let i = 0; i < count; i++) assert.ok((await port.accept(frame(i), 1, signal())).ok);
    const socket = sockets[0]!; const pending = port.flush(1, signal()); await tick();
    socket.receive(result("Book", 0, 0.02, variant !== "interimOnly"));
    if (variant === "overlap") socket.receive(result("Book", 0, 0.02));
    if (variant !== "noSummary") socket.receive({ type: "Metadata", channels: variant === "wrongChannel" ? 2 : 1, duration: 0.02 });
    socket.end(variant === "abnormalClose" ? 1006 : 1000);
    const final = await pending;
    assert.equal(final.ok, false);
    await port.close();
  });
}

test("Deepgram composes with Abby turn detection and preserves clarification quality", async () => {
  const { port, sockets } = fixture(); const assembler = new TurnAssembler("call", "session");
  const media = new MediaTurnController("session", {
    async speechStarted() { return ok(assembler.beginSpeech()); },
    acceptTranscript: assembler.accept.bind(assembler),
    async finishTurn(now) { return assembler.finish(now); },
  }, port, { silenceMs: 100 });
  for (let i = 0; i < 6; i++) {
    const input = frame(i); if (i >= 2) input.bytes.fill(0);
    assert.ok((await media.acceptMedia(input)).ok);
  }
  const input = frame(6); input.bytes.fill(0); const pending = media.acceptMedia(input); await tick();
  const socket = sockets[0]!;
  assert.equal(socket.sent.filter(item => typeof item === "string").length, 1);
  socket.receive(result("Book an appointment", 0, 0.14));
  socket.receive({ type: "Metadata", channels: 1, duration: 0.14 }); socket.end();
  const completed = await pending; assert.ok(completed.ok);
  if (completed.ok && completed.value.kind === "turnCompleted") {
    assert.equal(completed.value.value.text, "Book an appointment");
    assert.equal(completed.value.value.quality, "needsClarification");
  } else assert.fail("normal Abby turn must complete");
  await media.stop();
});

for (const phase of ["connect", "flush"] as const) {
  test(`Deepgram abort during ${phase} settles once and late finals cannot revive it`, async () => {
    const controller = new AbortController();
    const socket = new FakeSocket();
    const port = new DeepgramStreamingTranscription({ apiKey: "synthetic-key", sessionId: "session",
      socketFactory: () => socket as unknown as WebSocket });
    const accepted = port.accept(frame(), 1, controller.signal);
    if (phase === "flush") { socket.open(); assert.ok((await accepted).ok); }
    const pending = phase === "connect" ? accepted : port.flush(1, controller.signal);
    await tick(); controller.abort(); assert.equal((await pending).ok, false);
    socket.open(); socket.receive(result()); socket.receive({ type: "Metadata", channels: 1, duration: 0.02 }); socket.end();
    assert.equal((await port.accept(frame(1), 2, signal())).ok, false);
    assert.equal(socket.terminated, 1); await port.close();
  });
}

test("Deepgram cancellation of an active flush never yields a partial transcript", async () => {
  const { port, sockets } = fixture(); assert.ok((await port.accept(frame(), 1, signal())).ok);
  sockets[0]!.receive(result()); const pending = port.flush(1, signal()); await tick();
  await port.cancel(1); assert.equal((await pending).ok, false); assert.equal(sockets[0]!.terminated, 1);
});

for (const invalid of ["binary", "malformed", "error", "oversize", "earlySummary", "backpressure", "sequence"] as const) {
  test(`Deepgram rejects ${invalid} without exposing provider details or final text`, async () => {
    const { port, sockets } = fixture(); assert.ok((await port.accept(frame(), 1, signal())).ok);
    const socket = sockets[0]!;
    if (invalid === "binary") socket.emit("message", Buffer.from("secret"), true);
    if (invalid === "malformed") socket.emit("message", Buffer.from("{secret"), false);
    if (invalid === "error") socket.receive({ type: "Error", description: "secret" });
    if (invalid === "oversize") socket.emit("message", Buffer.alloc(64_001), false);
    if (invalid === "earlySummary") socket.receive({ type: "Metadata", channels: 1, duration: 0.02 });
    if (invalid === "backpressure") { socket.bufferedAmount = 1_000_001; await port.accept(frame(1), 1, signal()); }
    if (invalid === "sequence") await port.accept(frame(), 1, signal());
    assert.deepEqual(await port.flush(1, signal()), { ok: false, error: { kind: "transcriptionUnavailable" } });
    assert.equal(socket.terminated, 1); await port.close();
  });
}
