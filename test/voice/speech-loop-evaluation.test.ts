import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { parseSpeechLoopCorpus, runSpeechLoopEvaluation } from "../../src/voice/speech-loop-evaluation.ts";

const corpus = parseSpeechLoopCorpus(JSON.parse(readFileSync(new URL("../../eval/speech-loop-v1.json", import.meta.url),
  "utf8")) as unknown);

test("speech loop corpus pins two patient-free caller messages and safety words", () => {
  assert.equal(corpus.version, "speech-loop-v1");
  assert.deepEqual(corpus.cases.map(item => item.id), ["SL-001", "SL-002"]);
  const invalid = structuredClone(corpus) as unknown as { cases: { criticalTerms: string[] }[] };
  invalid.cases[1]!.criticalTerms = ["appointment", "patient"];
  assert.throws(() => parseSpeechLoopCorpus(invalid), /invalid speech loop case/);
});

test("E2E-150 synthetic speech loop preserves spoken disclosure and untrusted transcript quality", async () => {
  const item = corpus.cases[0]!;
  const pcm = new Uint8Array(1_280);
  const view = new DataView(pcm.buffer);
  for (let offset = 0; offset < pcm.byteLength; offset += 2) view.setInt16(offset, 1_200, true);
  let syntheses = 0;
  let frames = 0;
  const results = await runSpeechLoopEvaluation({ ...corpus, cases: [item] }, {
    async *stream(text) {
      assert.equal(text, item.text);
      syntheses += 1;
      yield pcm.subarray(0, 640);
      yield pcm.subarray(640);
    },
  }, sessionId => ({
    async accept(frame) {
      assert.equal(frame.sessionId, sessionId);
      assert.equal(frame.bytes.byteLength, 640);
      frames += 1;
      return ok([]);
    },
    async flush(generation) {
      return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: "synthetic-item",
        text: item.text, quality: "needsClarification" }]);
    },
  }), 2, 2, 0);
  assert.equal(syntheses, 2);
  assert.equal(frames, 4);
  assert.deepEqual(results.map(result => [result.verdict, result.quality, result.failedStage,
    result.synthesisChunks, result.synthesisBytes, result.peakSample]),
  [["match", "needsClarification", null, 2, 1_280, 1_200],
    ["match", "needsClarification", null, 2, 1_280, 1_200]]);
});

test("speech loop flags silent synthesis and missing safety language", async () => {
  const item = corpus.cases[1]!;
  const silent = await runSpeechLoopEvaluation({ ...corpus, cases: [item] }, {
    async *stream() { yield new Uint8Array(640); },
  }, () => { throw new Error("transcription must not start"); }, 1, 1, 0);
  assert.equal(silent[0]?.verdict, "providerFailure");
  assert.equal(silent[0]?.failedStage, "synthesis");
  const pcm = new Uint8Array(640);
  new DataView(pcm.buffer).setInt16(0, 500, true);
  const missing = await runSpeechLoopEvaluation({ ...corpus, cases: [item] }, {
    async *stream() { yield pcm; },
  }, sessionId => ({
    async accept() { return ok([]); },
    async flush(generation) { return ok([{ kind: "segmentFinal", sessionId, generation,
      utteranceId: "synthetic-item", text: "I found possible times for an appointment.",
      quality: "needsClarification" }]); },
  }), 1, 1, 0);
  assert.equal(missing[0]?.verdict, "critical");
  assert.equal(missing[0]?.failedStage, null);
});
