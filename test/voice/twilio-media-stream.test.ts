import assert from "node:assert/strict";
import test from "node:test";
import { TwilioMediaStream } from "../../src/voice/twilio-media-stream.ts";
import type { TwilioStreamEvent } from "../../src/voice/twilio-media-stream.ts";
import { StreamedPlaybackPort } from "../../src/voice/streamed-playback-port.ts";
import { TransportMediaNormalizer } from "../../src/voice/transport-media-normalizer.ts";

const accountSid = `AC${"1".repeat(32)}`;
const callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`;
const startedAt = "2026-09-29T10:00:00.000Z";

function value(result: { ok: true; value: TwilioStreamEvent } | { ok: false; error: { kind: string } }): TwilioStreamEvent {
  assert.ok(result.ok, result.ok ? "" : result.error.kind);
  return result.value;
}

function fixture(clearDeadlineMs = 2_000) {
  const sent: Record<string, unknown>[] = [];
  const adapter = new TwilioMediaStream({ accountSid, callSid, sessionId: "session", startedAt,
    clearDeadlineMs, send(json) { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued"; } });
  assert.equal(value(adapter.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }))).kind,
    "connected");
  assert.equal(value(adapter.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
    start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: {
      encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1,
    } } }))).kind, "started");
  return { adapter, sent };
}

function pcm(amplitude: number): Uint8Array {
  const bytes = new Uint8Array(640);
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length; offset += 2) view.setInt16(offset, amplitude, true);
  return bytes;
}

test("E2E-130 synthetic Twilio: inbound μ-law becomes Abby PCM and only the exact final mark can prove playback", async () => {
  const { adapter, sent } = fixture();
  const incoming = value(adapter.receive(JSON.stringify({ event: "media", sequenceNumber: "2", streamSid,
    media: { track: "inbound", chunk: "1", timestamp: "20", payload: Buffer.alloc(160, 0xff).toString("base64") } })));
  assert.equal(incoming.kind, "media");
  if (incoming.kind !== "media") return;
  assert.equal(incoming.frame.sequence, 0);
  assert.equal(incoming.frame.capturedAt, "2026-09-29T10:00:00.020Z");
  assert.equal(incoming.frame.bytes.length, 640);
  assert.equal(new DataView(incoming.frame.bytes.buffer).getInt16(0, true), 0);

  const playback = new StreamedPlaybackPort({ async *stream() { yield pcm(1_200); } }, adapter);
  assert.equal(await playback.enqueue("notice:playback", "Approved greeting", () => true), "queued");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.event, "media");
  const outbound = Buffer.from((sent[0]?.media as { payload: string }).payload, "base64");
  assert.equal(outbound.length, 160);
  const decoded = new TransportMediaNormalizer("pcmu/8000").normalize({ sessionId: "session", sequence: 0,
    capturedAt: startedAt, payload: outbound });
  assert.ok(decoded.ok);
  assert.ok(Math.abs(new DataView(decoded.value.bytes.buffer).getInt16(0, true) - 1_200) < 100);
  assert.equal(sent[1]?.event, "mark");
  assert.equal((sent[1]?.mark as { name: string }).name.length, 36);
  let settled = 0;
  const marked = value(adapter.receive(JSON.stringify({ event: "mark", sequenceNumber: "3", streamSid,
    mark: { name: (sent[1]?.mark as { name: string }).name } })));
  assert.equal(marked.kind, "played");
  if (marked.kind !== "played") return;
  assert.deepEqual(marked.completion, { playbackId: "notice:playback", lastSequence: 0, status: "played" });
  assert.deepEqual(await playback.acceptCompletion(marked.completion, async () => { settled += 1; return true; }),
    { ok: true, value: marked.completion });
  assert.equal(settled, 1);
});

test("E2E-130 synthetic Twilio: clear marks are never reported as played and the fence waits for Twilio's echo", async () => {
  const { adapter, sent } = fixture();
  const signal = new AbortController().signal;
  assert.equal(await adapter.queueChunk("notice:playback", 0, pcm(1_200), signal), "queued");
  assert.equal(await adapter.finishQueue("notice:playback", 0, signal), "queued");
  const completionName = (sent[1]?.mark as { name: string }).name;
  const clear = adapter.clear("notice:playback");
  assert.deepEqual(sent.map(item => item.event), ["media", "mark", "mark", "clear"]);
  const fenceName = (sent[2]?.mark as { name: string }).name;
  assert.equal(value(adapter.receive(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
    mark: { name: completionName } }))).kind, "ignoredMark");
  let finished = false;
  void clear.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(value(adapter.receive(JSON.stringify({ event: "mark", sequenceNumber: "3", streamSid,
    mark: { name: fenceName } }))).kind, "ignoredMark");
  assert.equal(await clear, true);
  assert.equal(await adapter.queueChunk("another:playback", 0, pcm(1_200), signal), "queued");
});

test("E2E-130 synthetic Twilio: identity, sequence, codec and missing clear evidence fail closed", async () => {
  const untrusted = new TwilioMediaStream({ accountSid, callSid, sessionId: "session", startedAt,
    send: () => "queued" });
  value(untrusted.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" })));
  assert.deepEqual(untrusted.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
    start: { accountSid: `AC${"9".repeat(32)}`, callSid, streamSid, tracks: ["inbound"], mediaFormat: {
      encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1,
    } } })), { ok: false, error: { kind: "invalidMedia" } });

  const wrong = fixture();
  assert.deepEqual(wrong.adapter.receive(JSON.stringify({ event: "media", sequenceNumber: "2", streamSid: `MZ${"4".repeat(32)}`,
    media: { track: "inbound", chunk: "1", timestamp: "0", payload: Buffer.alloc(160).toString("base64") } })),
  { ok: false, error: { kind: "invalidMedia" } });
  assert.deepEqual(wrong.adapter.receive("{}"), { ok: false, error: { kind: "streamClosed" } });

  const gap = fixture();
  assert.deepEqual(gap.adapter.receive(JSON.stringify({ event: "media", sequenceNumber: "3", streamSid,
    media: { track: "inbound", chunk: "1", timestamp: "0", payload: Buffer.alloc(160).toString("base64") } })),
  { ok: false, error: { kind: "invalidMedia" } });

  const malformed = fixture();
  assert.deepEqual(malformed.adapter.receive(JSON.stringify({ event: "media", sequenceNumber: "2", streamSid,
    media: { track: "inbound", chunk: "1", timestamp: "0", payload: "%%%" } })),
  { ok: false, error: { kind: "invalidMedia" } });

  const noFence = fixture(50);
  assert.equal(await noFence.adapter.queueChunk("notice:playback", 0, pcm(1_200), new AbortController().signal), "queued");
  assert.equal(await noFence.adapter.clear("notice:playback"), false);
  assert.equal(await noFence.adapter.queueChunk("next:playback", 0, pcm(1_200), new AbortController().signal), "notSent");
});
