import assert from "node:assert/strict";
import test from "node:test";
import { assessSyntheticSpeechLatency } from "../../src/voice/speech-latency-gate.ts";
import type { SpeechLatencySample } from "../../src/voice/speech-latency-gate.ts";

const good = { outcome: "queued" as const, chunks: 3, firstChunkMs: 1_000, totalMs: 3_000 };
const caseIds = ["SL-001", "SL-002"];
const passing = caseIds.flatMap(caseId => Array.from({ length: 20 }, (_, index) =>
  ({ ...good, caseId, repeat: index + 1 })));

test("E2E-181 speech latency gate includes all jobs and fails when p95 hides a failed call", () => {
  assert.equal(assessSyntheticSpeechLatency(passing, caseIds).status, "pass");
  assert.deepEqual(assessSyntheticSpeechLatency(passing.slice(0, 16), caseIds).failures,
    ["insufficientJobs", "corpusCoverage"]);
  const failed: SpeechLatencySample[] = [...passing];
  failed[0] = { ...passing[0]!, outcome: "notSent", chunks: 0, firstChunkMs: null, totalMs: 5_000 };
  const assessed = assessSyntheticSpeechLatency(failed, caseIds);
  assert.ok(assessed.failures.includes("failedJobs"));
  assert.equal(assessed.metrics.firstChunkP95Ms, 1_000);
  const late = [...passing];
  late[0] = { ...late[0]!, firstChunkMs: 5_100, totalMs: 6_100 };
  late[1] = { ...late[1]!, firstChunkMs: 5_100, totalMs: 6_100 };
  late[2] = { ...late[2]!, firstChunkMs: 5_100, totalMs: 6_100 };
  assert.ok(assessSyntheticSpeechLatency(late, caseIds).failures.includes("firstChunkP95"));
  assert.ok(assessSyntheticSpeechLatency(late, caseIds).failures.includes("lateJobs"));
  assert.ok(assessSyntheticSpeechLatency(late, caseIds).failures.includes("utteranceP95"));
});

test("E2E-181 speech latency gate rejects repeated, missing, or foreign corpus jobs", () => {
  const duplicate = [...passing];
  duplicate[0] = passing[1]!;
  assert.deepEqual(assessSyntheticSpeechLatency(duplicate, caseIds).failures, ["corpusCoverage"]);
  const foreign = [...passing];
  foreign[0] = { ...foreign[0]!, caseId: "SL-999" };
  assert.deepEqual(assessSyntheticSpeechLatency(foreign, caseIds).failures, ["corpusCoverage"]);
  const wrongRepeat = [...passing];
  wrongRepeat[0] = { ...wrongRepeat[0]!, repeat: 21 };
  assert.deepEqual(assessSyntheticSpeechLatency(wrongRepeat, caseIds).failures, ["corpusCoverage"]);
});
