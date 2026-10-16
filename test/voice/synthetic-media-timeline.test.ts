import assert from "node:assert/strict";
import test from "node:test";
import { TwilioMediaStream } from "../../src/voice/twilio-media-stream.ts";
import { SyntheticMediaTimeline, alignedSyntheticReplyEnd } from "../support/synthetic-media-timeline.ts";

const accountSid = `AC${"1".repeat(32)}`, callSid = `CA${"2".repeat(32)}`, streamSid = `MZ${"3".repeat(32)}`;
const origin = "2026-10-04T06:00:00.000Z";
test("delayed quiet-media callbacks cannot timestamp a later affirmation before a played readback", () => {
  const timeline = new SyntheticMediaTimeline(), stream = new TwilioMediaStream({ accountSid, callSid,
    sessionId: "synthetic", startedAt: origin, send: () => "queued" });
  assert.ok(stream.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" })).ok);
  assert.ok(stream.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
    start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } })).ok);
  let sequence = 2, last = -Infinity;
  const deliver = () => {
    const packet = timeline.next();
    const result = stream.receive(JSON.stringify({ event: "media", sequenceNumber: String(sequence++), streamSid,
      media: { track: "inbound", ...packet, payload: Buffer.alloc(160, 0xff).toString("base64") } }));
    assert.ok(result.ok && result.value.kind === "media");
    const at = Date.parse(result.value.frame.capturedAt); assert.ok(at > last); last = at;
  };
  for (let i = 0; i < 100; i++) deliver();
  // A scheduled callback delay dropped silence packets; host time did not stop.
  const playedAt = Date.parse(origin) + 5000, confirmedHostElapsed = alignedSyntheticReplyEnd(5000, timeline.nextTurnEndMs);
  timeline.alignTurnEnd(confirmedHostElapsed);
  deliver(); assert.ok(last >= playedAt, "even the first new speech frame must follow playback");
  for (let i = 1; i < 42; i++) deliver();
  assert.ok(last >= playedAt, "a real later Yes must not become a pre-playback affirmation");
  assert.ok(last <= Date.parse(origin) + confirmedHostElapsed, "the turn must not outrun the confirmed host clock");
});

for (const elapsed of [-1, NaN, 900001, 16000]) test(`invalid or oversized media alignment ${elapsed} cannot change the next packet`, () => {
  const timeline = new SyntheticMediaTimeline();
  assert.throws(() => timeline.alignTurnEnd(elapsed));
  assert.deepEqual(timeline.next(), { chunk: "1", timestamp: "0" });
});
test("an ordinary turn retains42 contiguous20ms packets after bounded reconciliation", () => {
  const timeline = new SyntheticMediaTimeline(); timeline.alignTurnEnd(timeline.nextTurnEndMs);
  const packets = Array.from({ length: 42 }, () => timeline.next());
  assert.deepEqual(packets.map(p => Number(p.chunk)), Array.from({ length: 42 }, (_, i) => i + 1));
  assert.deepEqual(packets.map(p => Number(p.timestamp)), Array.from({ length: 42 }, (_, i) => i * 20));
});

test("reply-clock reconciliation preserves the existing15s step and15min lifetime bounds", () => {
  assert.throws(() => alignedSyntheticReplyEnd(900000, 900000));
  assert.throws(() => alignedSyntheticReplyEnd(1000, 16001));
  assert.throws(() => alignedSyntheticReplyEnd(NaN, 1000));
});
