import assert from "node:assert/strict";
import test from "node:test";
import { assessSyntheticSpeechLatency } from "../../src/voice/speech-latency-gate.ts";
import type { SpeechLatencySample } from "../../src/voice/speech-latency-gate.ts";

const good = { outcome: "queued" as const, chunks: 3, firstChunkMs: 1_000, totalMs: 3_000 };

test("E2E-181 speech latency gate includes all jobs and fails when p95 hides a failed call", () => {
  const passing = Array.from({ length: 40 }, () => good);
  assert.equal(assessSyntheticSpeechLatency(passing).status, "pass");
  assert.deepEqual(assessSyntheticSpeechLatency(passing.slice(0, 16)).failures,
    ["insufficientJobs"]);
  const failed: SpeechLatencySample[] = [...passing];
  failed[0] = { outcome: "notSent", chunks: 0, firstChunkMs: null, totalMs: 5_000 };
  const assessed = assessSyntheticSpeechLatency(failed);
  assert.ok(assessed.failures.includes("failedJobs"));
  assert.equal(assessed.metrics.firstChunkP95Ms, 1_000);
  const late = [...passing];
  late[0] = { ...good, firstChunkMs: 5_100, totalMs: 6_100 };
  late[1] = { ...good, firstChunkMs: 5_100, totalMs: 6_100 };
  late[2] = { ...good, firstChunkMs: 5_100, totalMs: 6_100 };
  assert.ok(assessSyntheticSpeechLatency(late).failures.includes("firstChunkP95"));
  assert.ok(assessSyntheticSpeechLatency(late).failures.includes("lateJobs"));
  assert.ok(assessSyntheticSpeechLatency(late).failures.includes("utteranceP95"));
});
