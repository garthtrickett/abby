import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { ok } from "../../src/core/model.ts";
import { MediaTurnController } from "../../src/voice/media-turn-controller.ts";
import type { MediaFrame } from "../../src/voice/media-turn-controller.ts";
import { OpenAIRealtimeTranscription } from "../../src/voice/openai-realtime-transcription.ts";
import { TurnAssembler } from "../../src/voice/turn-assembler.ts";

const start = Date.parse("2026-09-28T10:00:00.000Z");

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  terminateCount = 0;

  open(): void { this.readyState = WebSocket.OPEN; this.emit("open"); }
  receive(event: object): void { this.emit("message", Buffer.from(JSON.stringify(event))); }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as Record<string, unknown>); }
  terminate(): void { this.terminateCount += 1; this.readyState = WebSocket.CLOSED; this.emit("close"); }
  close(): void { this.terminate(); }
}

function configured(socket: FakeSocket): void {
  socket.open();
  assert.deepEqual(socket.sent[0], { type: "session.update", session: { type: "transcription", audio: { input: {
    format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe" },
    turn_detection: null,
  } } } });
  socket.receive({ type: "session.updated", session: { type: "transcription", audio: { input: {
    format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe" },
    turn_detection: null,
  } } } });
}

function frame(sequence: number, amplitude: number): MediaFrame {
  const bytes = new Uint8Array(640);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, amplitude, true);
  return { sessionId: "session", sequence, capturedAt: new Date(start + sequence * 20).toISOString(), bytes };
}

test("E2E-129 synthetic voice: streamed PCM commits at Abby's turn boundary and only the matched final transcript becomes a turn", async () => {
  const socket = new FakeSocket();
  const transcription = new OpenAIRealtimeTranscription({ apiKey: "synthetic-key", sessionId: "session",
    socketFactory: (url, headers) => {
      assert.equal(url, "wss://api.openai.com/v1/realtime?intent=transcription");
      assert.deepEqual(headers, { Authorization: "Bearer synthetic-key" });
      return socket as unknown as WebSocket;
    } });
  const assembler = new TurnAssembler("call", "session");
  const media = new MediaTurnController("session", {
    async speechStarted() { return ok(assembler.beginSpeech()); },
    acceptTranscript: assembler.accept.bind(assembler),
    async finishTurn(now) { return assembler.finish(now); },
  }, transcription, { silenceMs: 100 });
  configured(socket);
  for (let sequence = 0; sequence < 6; sequence += 1) {
    const result = await media.acceptMedia(frame(sequence, sequence < 2 ? 2_000 : 0));
    assert.equal(result.ok, true);
  }
  const pending = media.acceptMedia(frame(6, 0));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(socket.sent.filter(item => item.type === "input_audio_buffer.commit").length, 1);
  const appends = socket.sent.filter(item => item.type === "input_audio_buffer.append");
  assert.ok(appends.length >= 7);
  const samples = appends.reduce((total, item) => total + Buffer.from(item.audio as string, "base64").length / 2, 0);
  assert.equal(samples, 7 * 480);
  socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "foreign", transcript: "Wrong patient" });
  socket.receive({ type: "input_audio_buffer.committed", item_id: "provider-item-1" });
  socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "provider-item-1",
    transcript: "Can I book a physio appointment?" });
  const result = await pending;
  assert.ok(result.ok);
  assert.equal(result.value.kind, "turnCompleted");
  if (result.value.kind !== "turnCompleted") return;
  assert.equal(result.value.value.text, "Can I book a physio appointment?");
  assert.equal(result.value.value.quality, "needsClarification");
  await media.stop();
  assert.equal(socket.terminateCount, 1);
});

test("E2E-146 synthetic voice: an early final waits for its committed item ID and is bounded", async () => {
  const socket = new FakeSocket();
  const transcription = new OpenAIRealtimeTranscription({ apiKey: "synthetic-key", sessionId: "session",
    socketFactory: () => socket as unknown as WebSocket });
  const assembler = new TurnAssembler("call", "session");
  const media = new MediaTurnController("session", {
    async speechStarted() { return ok(assembler.beginSpeech()); },
    acceptTranscript: assembler.accept.bind(assembler),
    async finishTurn(now) { return assembler.finish(now); },
  }, transcription, { silenceMs: 100 });
  configured(socket);
  for (let sequence = 0; sequence < 6; sequence += 1) {
    assert.ok((await media.acceptMedia(frame(sequence, sequence < 2 ? 2_000 : 0))).ok);
  }
  const pending = media.acceptMedia(frame(6, 0));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(socket.sent.filter(item => item.type === "input_audio_buffer.commit").length, 1);
  socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "foreign",
    transcript: "Wrong patient" });
  socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "provider-item",
    transcript: "Do you have possible times tomorrow?" });
  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  socket.receive({ type: "input_audio_buffer.committed", item_id: "provider-item" });
  const result = await pending;
  assert.ok(result.ok);
  assert.equal(result.value.kind, "turnCompleted");
  if (result.value.kind !== "turnCompleted") return;
  assert.equal(result.value.value.text, "Do you have possible times tomorrow?");
  assert.equal(result.value.value.quality, "needsClarification");
  await media.stop();

  const floodedSocket = new FakeSocket();
  const flooded = new OpenAIRealtimeTranscription({ apiKey: "synthetic-key", sessionId: "session",
    socketFactory: () => floodedSocket as unknown as WebSocket });
  configured(floodedSocket);
  assert.ok((await flooded.accept(frame(0, 2_000), 1, new AbortController().signal)).ok);
  const waiting = flooded.flush(1, new AbortController().signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  for (let index = 0; index < 9; index += 1) floodedSocket.receive({
    type: "conversation.item.input_audio_transcription.completed", item_id: `foreign-${index}`,
    transcript: "Unrelated", });
  assert.deepEqual(await waiting, { ok: false, error: { kind: "transcriptionUnavailable" } });
  assert.equal(floodedSocket.terminateCount, 1);
});

test("E2E-129 synthetic voice: rejected session, malformed completion and caller stop fail closed", async () => {
  const rejectedSocket = new FakeSocket();
  const rejected = new OpenAIRealtimeTranscription({ apiKey: "synthetic-key", sessionId: "session",
    socketFactory: () => rejectedSocket as unknown as WebSocket });
  rejectedSocket.open();
  rejectedSocket.receive({ type: "session.updated", session: { type: "realtime" } });
  assert.deepEqual(await rejected.accept(frame(0, 2_000), 1, new AbortController().signal),
    { ok: false, error: { kind: "transcriptionUnavailable" } });
  assert.equal(rejectedSocket.terminateCount, 1);

  const malformedSocket = new FakeSocket();
  const malformed = new OpenAIRealtimeTranscription({ apiKey: "synthetic-key", sessionId: "session",
    socketFactory: () => malformedSocket as unknown as WebSocket });
  configured(malformedSocket);
  assert.deepEqual(await malformed.accept(frame(0, 2_000), 1, new AbortController().signal), { ok: true, value: [] });
  const pending = malformed.flush(1, new AbortController().signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  malformedSocket.receive({ type: "input_audio_buffer.committed", item_id: "provider-item" });
  malformedSocket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "provider-item",
    transcript: 42 });
  assert.deepEqual(await pending, { ok: false, error: { kind: "transcriptionUnavailable" } });
  assert.equal(malformedSocket.terminateCount, 1);

  const stoppedSocket = new FakeSocket();
  const stopped = new OpenAIRealtimeTranscription({ apiKey: "synthetic-key", sessionId: "session",
    socketFactory: () => stoppedSocket as unknown as WebSocket });
  configured(stoppedSocket);
  assert.deepEqual(await stopped.accept(frame(0, 2_000), 1, new AbortController().signal), { ok: true, value: [] });
  const waiting = stopped.flush(1, new AbortController().signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  await stopped.cancel(1);
  assert.deepEqual(await waiting, { ok: false, error: { kind: "transcriptionUnavailable" } });
  assert.equal(stoppedSocket.terminateCount, 1);
});
