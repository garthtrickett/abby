import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { assessSyntheticTranscription } from "../../src/voice/transcription-evaluation-gate.ts";
import { parseTranscriptionEvaluationCorpus, runTranscriptionEvaluation } from "../../src/voice/transcription-evaluation.ts";
import type { TranscriptionEvaluationResult } from "../../src/voice/transcription-evaluation.ts";

const file = new URL("../../eval/transcription-safety-v1.json", import.meta.url);
const corpus = parseTranscriptionEvaluationCorpus(JSON.parse(readFileSync(file, "utf8")) as unknown);
const expected = [{ id: "SG-001", expectedText: "Please book on Friday.",
  criticalTerms: ["book", "Friday"] }];
const base = (repeat: number): TranscriptionEvaluationResult => ({ caseId: "SG-001", category: "booking",
  repeat, verdict: "match", actualText: "Please book on Friday.", totalMs: 2_000,
  finalMs: 1_000, quality: "needsClarification" });

test("E2E-180 safety audio pins eight patient-free telephone fixtures across two voices", async () => {
  assert.equal(corpus.version, "transcription-safety-v1");
  assert.equal(corpus.cases.length, 8);
  assert.deepEqual(new Set(corpus.cases.map(item => item.category.split("-").slice(0, -2).join("-"))),
    new Set(["domain-date", "weekday-number", "email-address", "currency-number"]));
  const audio = corpus.cases.map(item => {
    const pcm = readFileSync(new URL(`../../eval/audio/${item.file}`, import.meta.url));
    assert.ok(pcm.length > 640 && pcm.length < 1_000_000 && pcm.length % 640 === 0);
    assert.equal(createHash("sha256").update(pcm).digest("hex"), item.sha256);
    return pcm;
  });
  for (let index = 0; index < 4; index += 1) assert.notDeepEqual(audio[index], audio[index + 4]);
  const first = corpus.cases[0]!;
  let consumed = 0;
  const result = await runTranscriptionEvaluation([{ id: first.id, category: first.category,
    expectedText: first.expectedText, criticalTerms: first.criticalTerms, pcm: audio[0]! }],
  sessionId => ({ async accept(frame) { consumed += frame.bytes.length; return ok([]); },
    async flush(generation) { return ok([{ kind: "segmentFinal" as const, sessionId, generation,
      utteranceId: "one", text: first.expectedText, quality: "needsClarification" as const }]); } }), 1, 1, 0);
  assert.equal(consumed, audio[0]!.length);
  assert.equal(result[0]?.verdict, "match");
  assert.equal(result[0]?.quality, "needsClarification");
});

test("synthetic speech gate checks repeated accuracy and final latency without granting release", () => {
  const passing = [base(1), base(2), base(3)];
  assert.deepEqual(assessSyntheticTranscription(expected, passing).failures, []);
  const failed = [base(1), { ...base(2), actualText: "Please", verdict: "critical" as const },
    { ...base(3), actualText: "", verdict: "critical" as const, finalMs: 5_500 }];
  const assessed = assessSyntheticTranscription(expected, failed);
  assert.equal(assessed.status, "fail");
  assert.ok(assessed.failures.includes("critical"));
  assert.ok(assessed.failures.includes("empty"));
  assert.ok(assessed.failures.includes("truncated"));
  assert.ok(assessed.failures.includes("wordErrorRate"));
  assert.ok(assessed.failures.includes("finalP95"));
  assert.ok(assessed.failures.includes("delayed"));
  assert.deepEqual(assessSyntheticTranscription(expected, [base(1)]).failures,
    ["insufficientRepeats"]);
  const misstated = [...passing];
  misstated[0] = { ...base(1), actualText: "Please look on Friday." };
  assert.ok(assessSyntheticTranscription(expected, misstated).failures.includes("critical"));
});
