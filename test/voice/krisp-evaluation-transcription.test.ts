import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { err, ok } from "../../src/core/model.ts";
import type { MediaFrame, TranscriptionPort } from "../../src/voice/media-turn-controller.ts";
import { KrispEvaluationTranscription } from "../../scripts/lib/krisp-evaluation-transcription.ts";
import { DeepgramStreamingTranscription } from "../../src/voice/deepgram-streaming-transcription.ts";

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  terminated = 0;
  autoReady = true;
  autoClose = true;
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  receive(value: object | Buffer) {
    this.emit("message", Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)), Buffer.isBuffer(value));
  }
  send(value: string | Buffer) {
    this.sent.push(value);
    if (typeof value === "string" && this.autoReady) queueMicrotask(() => this.receive({ type: "ready" }));
  }
  close(code: number) { if (this.autoClose) { this.readyState = WebSocket.CLOSED; this.emit("close", code); } }
  terminate() { this.terminated++; this.readyState = WebSocket.CLOSED; this.emit("close", 1006); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const frame = (sequence: number): MediaFrame => ({ sessionId: "synthetic", sequence,
  capturedAt: new Date(Date.parse("2026-10-23T00:00:00Z") + sequence * 20).toISOString(),
  bytes: new Uint8Array(640).fill(sequence + 11) });
const tokenResponse = (data: Record<string, unknown> = {}) => new Response(JSON.stringify({ code: 0,
  data: { session_key: "short-lived-session-token", status: "LICENSE_VALID", type: "session", usage_type: "viva",
    expires_at: new Date(Date.now() + 300_000).toISOString(), ...data } }));

function fixture(options: { fetch?: typeof fetch; socket?: Socket; inner?: TranscriptionPort } = {}) {
  const socket = options.socket ?? new Socket(), controller = new AbortController();
  const forwarded: MediaFrame[] = [];
  let flushes = 0, closes = 0, sockets = 0;
  const inner: TranscriptionPort = options.inner ?? {
    async accept(input, generation) { assert.equal(generation, 1); forwarded.push(input); return ok([]); },
    async flush(generation) { flushes++; assert.equal(generation, 1); return ok([{ kind: "segmentFinal",
      sessionId: "synthetic", generation: 1, utteranceId: "one", text: "synthetic final", quality: "needsClarification" }]); },
    async close() { closes++; },
  };
  const port = new KrispEvaluationTranscription({ apiKey: "master-test-only", sessionId: "synthetic", transcription: inner,
    fetch: options.fetch ?? (async (url, init) => {
      assert.equal(url, "https://api.developers.krisp.ai/v2/sdk/tokens/session");
      assert.equal(init!.method, "POST"); assert.equal(init!.redirect, "error");
      assert.deepEqual(init!.headers, { Authorization: "api-key master-test-only", "Content-Type": "application/json" });
      assert.deepEqual(JSON.parse(init!.body as string), { usage_type: "viva", expiration_ttl: 5 });
      return tokenResponse();
    }) as typeof fetch,
    socketFactory(url, headers) {
      sockets++; assert.equal(url, "wss://streaming.krisp.ai/voice-isolation");
      assert.deepEqual(headers, { Authorization: "api-key short-lived-session-token" });
      queueMicrotask(() => socket.open()); return socket as unknown as WebSocket;
    } });
  return { port, socket, forwarded, controller, signal: controller.signal,
    stats: () => ({ flushes, closes, sockets }) };
}

test("Krisp uses product-scoped session auth, waits for ready and restores original frames after tail padding", async () => {
  const f = fixture(), originals = [frame(0), frame(1)];
  try {
    assert.ok((await f.port.accept(originals[0]!, 1, f.signal)).ok);
    assert.equal(f.socket.sent.length, 1, "20 ms cannot be sent as a 30 ms provider frame");
    assert.deepEqual(JSON.parse(f.socket.sent[0] as string), { model: "VIVA-tel", sample_rate: 16_000, suppression_level: 100 });
    assert.ok((await f.port.accept(originals[1]!, 1, f.signal)).ok);
    const first = f.socket.sent[1] as Buffer; assert.equal(first.length, 960);
    const expected = Buffer.concat(originals.map(item => Buffer.from(item.bytes)));
    assert.deepEqual(first, expected.subarray(0, 960));
    originals[0]!.bytes.fill(99); assert.equal(first[0], 11, "owned transport bytes");
    f.socket.receive(first); await tick(); assert.equal(f.forwarded.length, 1);
    const final = f.port.flush(1, f.signal); await tick();
    const last = f.socket.sent[2] as Buffer;
    assert.equal(last.length, 960); assert.deepEqual(last.subarray(0, 320), expected.subarray(960));
    assert.ok(last.subarray(320).every(byte => byte === 0));
    assert.equal(f.stats().flushes, 0, "STT must wait for every cleaned frame");
    f.socket.receive(last); const result = await final;
    assert.ok(result.ok); if (result.ok) assert.equal(result.value[0]?.kind, "segmentFinal");
    assert.deepEqual(Buffer.concat(f.forwarded.map(item => Buffer.from(item.bytes))), expected);
    assert.deepEqual(f.forwarded.map(item => [item.sequence, item.capturedAt]), originals.map(item => [item.sequence, item.capturedAt]));
    assert.equal(f.stats().flushes, 1);
    assert.equal((await f.port.accept(frame(0), 2, f.signal)).ok, false);
    assert.equal((await f.port.flush(1, f.signal)).ok, false);
  } finally { await f.port.close(); }
});

test("Krisp does not send any audio before provider ready", async () => {
  const socket = new Socket(); socket.autoReady = false;
  const f = fixture({ socket });
  try {
    const accepting = f.port.accept(frame(0), 1, f.signal); await tick();
    assert.equal(socket.sent.length, 1); assert.equal(f.forwarded.length, 0);
    socket.receive({ type: "ready" }); assert.ok((await accepting).ok);
  } finally { await f.port.close(); }
});

for (const [name, data] of Object.entries({ expired: { expires_at: "2000-01-01T00:00:00Z" },
  invalidDate: { expires_at: "unparseable" }, wrongProduct: { usage_type: "stt" }, masterReuse: { session_key: "master-test-only" },
  wrongStatus: { status: "EXPIRED" }, injection: { session_key: "bad\r\nheader" }, wrongType: { type: "master" } })) {
  test(`Krisp refuses invalid session-token response: ${name}`, async () => {
    const f = fixture({ fetch: (async () => tokenResponse(data)) as typeof fetch });
    assert.equal((await f.port.accept(frame(0), 1, f.signal)).ok, false);
    assert.equal(f.stats().sockets, 0); assert.equal(f.forwarded.length, 0); await f.port.close();
  });
}

for (const [name, response] of [["HTTP refusal", () => new Response("private provider detail", { status: 403 })],
  ["oversize token body", () => new Response("x".repeat(16_385))], ["malformed JSON", () => new Response("not JSON")]] as const) {
  test(`Krisp bounds and redacts ${name}`, async () => {
    const f = fixture({ fetch: (async () => response()) as typeof fetch });
    assert.deepEqual(await f.port.accept(frame(0), 1, f.signal), err({ kind: "transcriptionUnavailable" }));
    assert.equal(f.stats().sockets, 0); await f.port.close();
  });
}

for (const variant of ["short", "unsolicited", "providerError", "abnormalClose", "duplicateReady"] as const) {
  test(`Krisp refuses incomplete or inconsistent streaming output: ${variant}`, async () => {
    const f = fixture(); assert.ok((await f.port.accept(frame(0), 1, f.signal)).ok);
    if (variant === "short") { await f.port.accept(frame(1), 1, f.signal); f.socket.receive(Buffer.alloc(640)); }
    else if (variant === "unsolicited") f.socket.receive(Buffer.alloc(960));
    else if (variant === "providerError") f.socket.receive({ type: "error", message: "private" });
    else if (variant === "abnormalClose") f.socket.emit("close", 1006);
    else f.socket.receive({ type: "ready" });
    assert.equal((await f.port.flush(1, f.signal)).ok, false);
    assert.equal(f.stats().flushes, 0); await f.port.close();
  });
}

test("Krisp cancellation retires late output and cannot leak it into another generation", async () => {
  const f = fixture(); await f.port.accept(frame(0), 1, f.signal);
  const pending = f.port.flush(1, f.signal); await tick();
  f.controller.abort(); assert.equal((await pending).ok, false);
  f.socket.receive(Buffer.alloc(960)); await tick();
  assert.equal(f.forwarded.length, 0); assert.equal(f.socket.terminated, 1);
  assert.equal((await f.port.accept(frame(0), 2, new AbortController().signal)).ok, false);
});

for (const stalled of ["denoiserTail", "denoiserClose", "transcriptionFlush"] as const) {
  test(`Krisp and STT share one flush deadline: ${stalled}`, { timeout: 5_000 }, async () => {
    let innerAborted = false;
    const f = fixture(stalled === "transcriptionFlush" ? { inner: {
      async accept() { return ok([]); }, async flush(_generation, signal) {
        signal.addEventListener("abort", () => { innerAborted = true; });
        return new Promise(() => {});
      }, async close() {},
    } } : {});
    try {
      await f.port.accept(frame(0), 1, f.signal);
      if (stalled === "denoiserClose") f.socket.autoClose = false;
      const start = performance.now(), pending = f.port.flush(1, f.signal); await tick();
      if (stalled !== "denoiserTail") f.socket.receive(f.socket.sent[1] as Buffer);
      assert.equal((await pending).ok, false);
      assert.ok(performance.now() - start < 2_800, "no second independent 2-second allowance");
      if (stalled === "transcriptionFlush") assert.equal(innerAborted, true);
    } finally { await f.port.close(); }
  });
}

for (const completeSummary of [true, false]) {
  test(`Krisp composes with the real Nova-3 port and requires its complete-duration finality: ${completeSummary}`, async () => {
    const deepgram = new Socket(); deepgram.autoReady = false;
    const transcription = new DeepgramStreamingTranscription({ apiKey: "synthetic-deepgram-key", sessionId: "synthetic",
      keyterms: ["physiotherapy"], socketFactory(url) {
        assert.deepEqual(new URL(url).searchParams.getAll("keyterm"), ["physiotherapy"]);
        queueMicrotask(() => deepgram.open()); return deepgram as unknown as WebSocket;
      } });
    const f = fixture({ inner: transcription });
    try {
      const originals = [frame(0), frame(1)], originalBytes = Buffer.concat(originals.map(item => Buffer.from(item.bytes)));
      for (const item of originals) assert.ok((await f.port.accept(item, 1, f.signal)).ok);
      f.socket.receive(Buffer.alloc(960, 37)); await tick();
      const pending = f.port.flush(1, f.signal); await tick();
      f.socket.receive(Buffer.alloc(960, 41)); await tick();
      const submitted = Buffer.concat(deepgram.sent.filter((item): item is Buffer => Buffer.isBuffer(item)));
      assert.deepEqual(submitted, Buffer.concat([Buffer.alloc(960, 37), Buffer.alloc(320, 41)]),
        "Nova-3 receives cleaned audio, with the last 640 transport-only bytes removed");
      assert.equal(submitted.length, originalBytes.length);
      assert.deepEqual(Buffer.concat(originals.map(item => Buffer.from(item.bytes))), originalBytes,
        "the source fixtures remain unchanged");
      assert.equal(deepgram.sent.at(-1), '{"type":"CloseStream"}');
      deepgram.receive({ type: "Results", is_final: true, start: 0, duration: 0.04, channel_index: [0, 1],
        channel: { alternatives: [{ transcript: "Synthetic appointment", confidence: 1 }] } });
      deepgram.receive({ type: "Metadata", channels: 1, duration: completeSummary ? 0.04 : 0.02 });
      deepgram.close(1000);
      const result = await pending;
      assert.equal(result.ok, completeSummary);
      if (result.ok) assert.deepEqual(result.value.map(item => ({ sessionId: item.sessionId, generation: item.generation,
        text: item.text, quality: item.kind === "segmentFinal" ? item.quality : undefined })),
        [{ sessionId: "synthetic", generation: 1, text: "Synthetic appointment", quality: "needsClarification" }]);
    } finally { await f.port.close(); }
  });
}

test("Krisp token acquisition has a bounded deadline even without caller abort", { timeout: 5_000 }, async () => {
  let tokenSignal: AbortSignal | undefined;
  const f = fixture({ fetch: (async (_url, init) => {
    tokenSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }) as typeof fetch });
  try {
    assert.equal((await f.port.accept(frame(0), 1, f.signal)).ok, false);
    assert.equal(tokenSignal?.aborted, true);
    assert.equal(f.stats().sockets, 0);
  } finally { await f.port.close(); }
});
