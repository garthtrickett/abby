import assert from "node:assert/strict";
import test from "node:test";
import { TransportMediaNormalizer } from "../../src/voice/transport-media-normalizer.ts";

const capturedAt = "2026-09-28T10:00:00.000Z";

test("G.711 μ-law decodes signed boundary samples and emits copied PCM16LE at 16 kHz", () => {
  const source = new Uint8Array(80).fill(0xff);
  source.set([0xff, 0x7f, 0x80, 0x00]);
  const normalized = new TransportMediaNormalizer("pcmu/8000").normalize({ sessionId: "session", sequence: 0,
    capturedAt, payload: source });
  assert.ok(normalized.ok);
  const samples = new DataView(normalized.value.bytes.buffer);
  assert.deepEqual(Array.from({ length: 8 }, (_, index) => samples.getInt16(index * 2, true)),
    [0, 0, 0, 0, 32_124, 32_124, -32_124, -32_124]);
  assert.equal(normalized.value.bytes.length, 320);
  source.fill(0);
  assert.equal(samples.getInt16(0, true), 0);
});

test("normalization rejects malformed frames without passing them to endpointing", () => {
  const pcmu = new TransportMediaNormalizer("pcmu/8000");
  const valid = { sessionId: "session", sequence: 0, capturedAt, payload: new Uint8Array(160) };
  for (const frame of [{ ...valid, sessionId: " " }, { ...valid, sequence: -1 },
    { ...valid, capturedAt: "not-a-time" }, { ...valid, payload: new Uint8Array(79) },
    { ...valid, payload: new Uint8Array(801) }, { ...valid, payload: new Uint8Array(161) }]) {
    const result = pcmu.normalize(frame);
    assert.ok(!result.ok);
    assert.equal(result.error.kind, "invalidMedia");
  }
  const pcm = new TransportMediaNormalizer("pcm16le/16000");
  assert.equal(pcm.normalize({ ...valid, payload: new Uint8Array(319) }).ok, false);
  assert.equal(pcm.normalize({ ...valid, payload: new Uint8Array(3_201) }).ok, false);
  const original = new Uint8Array(640);
  const normalized = pcm.normalize({ ...valid, payload: original });
  assert.ok(normalized.ok);
  original[0] = 42;
  assert.equal(normalized.value.bytes[0], 0);
});
