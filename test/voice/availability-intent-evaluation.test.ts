import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { parseAvailabilityEvaluationCorpus, runAvailabilityIntentEvaluation } from "../../src/standalone/availability-intent-evaluation.ts";

const file = new URL("../../eval/availability-intent-v1.json", import.meta.url);

test("availability intent evaluation corpus is versioned, bounded, and free of patient records", () => {
  const corpus = parseAvailabilityEvaluationCorpus(JSON.parse(readFileSync(file, "utf8")) as unknown);
  assert.equal(corpus.version, "availability-intent-v1");
  assert.equal(corpus.cases.length, 18);
  assert.ok(corpus.cases.some(item => item.expected.kind === "availability"));
  assert.ok(corpus.cases.some(item => item.criticalIfMissed && item.expected.kind === "unsupported"));
  const invalid = structuredClone(corpus) as unknown as { cases: { id: string }[] };
  invalid.cases[1]!.id = invalid.cases[0]!.id;
  assert.throws(() => parseAvailabilityEvaluationCorpus(invalid), /invalid availability evaluation case/);
  const invalidRange = structuredClone(corpus) as unknown as { cases: { expected: object }[] };
  invalidRange.cases[0]!.expected =
    { kind: "availability", from: "2026-10-01", to: "2026-10-10" };
  assert.throws(() => parseAvailabilityEvaluationCorpus(invalidRange), /invalid availability expectation/);
});

test("availability intent evaluation repeats cases in parallel and flags unsafe decisions", async () => {
  const corpus = parseAvailabilityEvaluationCorpus({ schemaVersion: 1, version: "synthetic", clinicDate: "2026-09-29",
    cases: [
      { id: "read", category: "read", callerText: "Check October 2", expected: {
        kind: "availability", from: "2026-10-02", to: "2026-10-02" }, criticalIfMissed: false },
      { id: "write", category: "write", callerText: "Book October 2", expected: { kind: "unsupported" },
        criticalIfMissed: true },
    ] });
  let active = 0;
  let peak = 0;
  const results = await runAvailabilityIntentEvaluation(corpus, async turn => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    active -= 1;
    return ok({ kind: "availability", from: "2026-10-02", to: "2026-10-02" });
  }, 2, 2);
  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => [result.caseId, result.repeat, result.verdict, result.actual]), [
    ["read", 1, "match", "availability"], ["read", 2, "match", "availability"],
    ["write", 1, "critical", "availability"], ["write", 2, "critical", "availability"],
  ]);
  assert.ok(results.every(result => result.elapsedMs >= 0));
  assert.equal(JSON.stringify(results).includes("Book October 2"), false);
  await assert.rejects(runAvailabilityIntentEvaluation(corpus, async () => ok({ kind: "model" }), 1, 9),
    /invalid availability evaluation run/);
});
