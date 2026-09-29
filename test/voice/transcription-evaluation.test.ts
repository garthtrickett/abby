import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { err, ok } from "../../src/core/model.ts";
import { parseTranscriptionEvaluationCorpus, runTranscriptionEvaluation } from "../../src/voice/transcription-evaluation.ts";

const corpusFile = new URL("../../eval/transcription-v1.json", import.meta.url);
const sample = new Uint8Array(1_280);

test("synthetic transcription corpus pins three patient-free 16 kHz PCM fixtures", () => {
  const corpus = parseTranscriptionEvaluationCorpus(JSON.parse(readFileSync(corpusFile, "utf8")) as unknown);
  assert.equal(corpus.version, "transcription-v1");
  assert.equal(corpus.cases.length, 3);
  for (const item of corpus.cases) {
    const bytes = readFileSync(new URL(`../../eval/audio/${item.file}`, import.meta.url));
    assert.ok(bytes.length >= 640 && bytes.length <= 1_000_000 && bytes.length % 2 === 0);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  }
  const invalid = structuredClone(corpus) as unknown as { cases: { file: string }[] };
  invalid.cases[0]!.file = "../patient-recording.pcm";
  assert.throws(() => parseTranscriptionEvaluationCorpus(invalid), /invalid transcription evaluation case/);
  const duplicate = structuredClone(corpus) as unknown as { cases: { id: string }[] };
  duplicate.cases[1]!.id = duplicate.cases[0]!.id;
  assert.throws(() => parseTranscriptionEvaluationCorpus(duplicate), /invalid transcription evaluation case/);
  const incorrectTerm = structuredClone(corpus) as unknown as { cases: { criticalTerms: string[] }[] };
  incorrectTerm.cases[0]!.criticalTerms = ["patient"];
  assert.throws(() => parseTranscriptionEvaluationCorpus(incorrectTerm), /invalid transcription evaluation case/);
});

test("E2E-152 telephone-band corpus pins and replays distinct G.711 normalized fixtures", async () => {
  const file = new URL("../../eval/transcription-telephony-v1.json", import.meta.url);
  const corpus = parseTranscriptionEvaluationCorpus(JSON.parse(readFileSync(file, "utf8")) as unknown);
  assert.equal(corpus.version, "transcription-telephony-v1");
  assert.equal(corpus.cases.length, 3);
  for (const item of corpus.cases) {
    const bytes = readFileSync(new URL(`../../eval/audio/${item.file}`, import.meta.url));
    const cleanName = item.file.replace("-pcmu-8k.pcm", ".pcm");
    const clean = readFileSync(new URL(`../../eval/audio/${cleanName}`, import.meta.url));
    assert.ok(bytes.length >= 640 && bytes.length <= 1_000_000 && bytes.length % 640 === 0);
    assert.notDeepEqual(bytes, clean);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  }
  const first = corpus.cases[0];
  assert.ok(first);
  const pcm = readFileSync(new URL(`../../eval/audio/${first.file}`, import.meta.url));
  let acceptedBytes = 0;
  const results = await runTranscriptionEvaluation([{ id: first.id, category: first.category,
    expectedText: first.expectedText, criticalTerms: first.criticalTerms, pcm }], sessionId => ({
    async accept(frame) { acceptedBytes += frame.bytes.length; return ok([]); },
    async flush() { return ok([{ kind: "segmentFinal" as const, sessionId, generation: 1,
      utteranceId: "telephony-fixture", text: first.expectedText, quality: "needsClarification" as const }]); },
    async close() {},
  }), 1, 1, 0);
  assert.equal(acceptedBytes, pcm.length);
  assert.deepEqual(results.map(result => [result.verdict, result.quality]),
    [["match", "needsClarification"]]);
});

test("E2E-161 two-speaker noisy telephone corpus pins patient-free fixtures and keeps finals untrusted", async () => {
  const file = new URL("../../eval/transcription-noise-v1.json", import.meta.url);
  const corpus = parseTranscriptionEvaluationCorpus(JSON.parse(readFileSync(file, "utf8")) as unknown);
  assert.equal(corpus.version, "transcription-noise-v1");
  assert.equal(corpus.cases.length, 6);
  const audio = corpus.cases.map(item => {
    const bytes = readFileSync(new URL(`../../eval/audio/${item.file}`, import.meta.url));
    assert.ok(bytes.length >= 640 && bytes.length <= 1_000_000 && bytes.length % 640 === 0);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
    return bytes;
  });
  for (let index = 0; index < 3; index += 1) {
    assert.notDeepEqual(audio[index], audio[index + 3]);
    const cleanFile = corpus.cases[index + 3]!.file.replace("-slt-white-10db-pcmu-8k.pcm", "-pcmu-8k.pcm");
    const clean = readFileSync(new URL(`../../eval/audio/${cleanFile}`, import.meta.url));
    assert.notDeepEqual(audio[index + 3], clean);
  }
  const item = corpus.cases[2]!;
  const results = await runTranscriptionEvaluation([{ id: item.id, category: item.category,
    expectedText: item.expectedText, criticalTerms: item.criticalTerms, pcm: audio[2]! }], sessionId => ({
    async accept() { return ok([]); },
    async flush() { return ok([{ kind: "segmentFinal" as const, sessionId, generation: 1,
      utteranceId: "noisy-fixture", text: item.expectedText, quality: "needsClarification" as const }]); },
    async close() {},
  }), 1, 1, 0);
  assert.deepEqual(results.map(result => [result.verdict, result.quality]), [["match", "needsClarification"]]);
});

test("transcription evaluation replays bounded frames concurrently and keeps untrusted quality", async () => {
  let active = 0;
  let peak = 0;
  let frames = 0;
  const results = await runTranscriptionEvaluation([{ id: "TE-001", category: "availability-date",
    expectedText: "Are there appointments available on Thursday?", criticalTerms: ["Thursday"], pcm: sample }],
  sessionId => {
    active += 1;
    peak = Math.max(peak, active);
    return {
      async accept(frame, generation) {
        assert.equal(frame.sessionId, sessionId);
        assert.equal(generation, 1);
        assert.equal(frame.bytes.length, 640);
        frames += 1;
        await new Promise<void>(resolve => setTimeout(resolve, 5));
        return ok([]);
      },
      async flush(generation) {
        return ok([{ kind: "segmentFinal" as const, sessionId, generation, utteranceId: "item-1",
          text: "Are there appointments available on Thursday?", quality: "needsClarification" as const }]);
      },
      async close() { active -= 1; },
    };
  }, 2, 2, 0);
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(frames, 4);
  assert.deepEqual(results.map(result => [result.verdict, result.quality, result.finalMs !== null]),
    [["match", "needsClarification", true], ["match", "needsClarification", true]]);
});

test("transcription evaluation flags a missing safety term and unavailable provider separately", async () => {
  const item = { id: "TE-002", category: "booking-request", expectedText: "Please book Friday.",
    criticalTerms: ["book", "Friday"], pcm: sample };
  const critical = await runTranscriptionEvaluation([item], sessionId => ({
    async accept() { return ok([]); },
    async flush() { return ok([{ kind: "segmentFinal" as const, sessionId, generation: 1,
      utteranceId: "item-1", text: "Please look Friday.", quality: "needsClarification" as const }]); },
    async close() {},
  }), 1, 1, 0);
  assert.equal(critical[0]?.verdict, "critical");
  const unavailable = await runTranscriptionEvaluation([item], () => ({
    async accept() { return ok([]); },
    async flush() { return err({ kind: "transcriptionUnavailable" as const }); },
    async close() {},
  }), 1, 1, 0);
  assert.equal(unavailable[0]?.verdict, "providerFailure");
  assert.equal(unavailable[0]?.actualText, "");
  assert.equal(unavailable[0]?.quality, "unavailable");
  await assert.rejects(runTranscriptionEvaluation([item], () => { throw new Error("unused"); }, 1, 5, 0),
    /invalid transcription evaluation run/);
});
