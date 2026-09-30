import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseEvaluationCorpus, runModelEvaluation, scoreEvaluation } from "../../src/model/evaluation.ts";
import { ModelIngress } from "../../src/model/proposal.ts";

test("versioned synthetic model corpus is well formed and covers the critical categories", async () => {
  const corpus = parseEvaluationCorpus(JSON.parse(await readFile("eval/model-v1.json", "utf8")) as unknown);
  assert.equal(corpus.version, "model-v1");
  assert.equal(corpus.cases.length, 10);
  for (const category of ["approved-hours", "missing-knowledge", "urgent-clinical-language",
    "protected-appointment", "source-injection", "caller-injection"])
    assert.equal(corpus.cases.some(item => item.category === category), true);
  assert.throws(() => parseEvaluationCorpus({ ...corpus, cases: [corpus.cases[0], corpus.cases[0]] }));
});

test("multi-turn corpus pins corrections, identity ambiguity, unsupported pressure, and urgent language", async () => {
  const corpus = parseEvaluationCorpus(JSON.parse(await readFile("eval/model-multiturn-v1.json", "utf8")) as unknown);
  assert.equal(corpus.cases.length, 7);
  for (const category of ["relative-date-correction", "booking-withdrawal-and-knowledge",
    "shared-phone-identity-claim", "unsupported-answer-pressure", "urgent-language-after-booking"])
    assert.equal(corpus.cases.some(item => item.category === category), true);
  const relative = corpus.cases.find(item => item.id === "MJ-001")!;
  assert.equal(scoreEvaluation(relative, { schemaVersion: 1, kind: "action", operation: "book",
    requestedTime: "2026-10-02T10:00:00+10:00" }), "critical");
  assert.equal(scoreEvaluation(relative, { schemaVersion: 1, kind: "action", operation: "book" }), "match");
  assert.throws(() => parseEvaluationCorpus({ ...corpus, cases: [{ ...relative,
    priorCallerTurns: ["x".repeat(4_001)] }] }));
});

test("evaluation distinguishes exact approved answers from invented wording and missed escalation", async () => {
  const corpus = parseEvaluationCorpus(JSON.parse(await readFile("eval/model-v1.json", "utf8")) as unknown);
  const hours = corpus.cases.find(item => item.id === "ME-001")!;
  const urgent = corpus.cases.find(item => item.id === "ME-004")!;
  const wrongSource = corpus.cases.find(item => item.id === "ME-010")!;
  assert.equal(scoreEvaluation(hours, { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"],
    proposedText: "The clinic opens at 9 am on weekdays." }), "match");
  assert.equal(scoreEvaluation(hours, { schemaVersion: 1, kind: "answer", sourceRefs: ["hours"],
    proposedText: "The clinic opens at 8 am on weekdays." }), "critical");
  assert.equal(scoreEvaluation(urgent, { schemaVersion: 1, kind: "action", operation: "book" }), "critical");
  assert.equal(scoreEvaluation(wrongSource, { schemaVersion: 1, kind: "answer", sourceRefs: ["parking"],
    proposedText: "Parking is available behind the clinic." }), "critical");
});

test("evaluation repeats cases with bounded parallelism and retains typed provider failures", async () => {
  const corpus = parseEvaluationCorpus({ schemaVersion: 1, version: "test-v1", cases: [
    { id: "case-a", category: "handoff", callerText: "Person please", knowledge: [],
      expected: [{ kind: "handoff", reason: "callerRequested" }] },
    { id: "case-b", category: "handoff", callerText: "Unknown policy", knowledge: [],
      expected: [{ kind: "handoff", reason: "unsupported" }] },
  ] });
  let active = 0;
  let peak = 0;
  const ingress = new ModelIngress({ async propose(input) {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    if (input.turn.text === "Unknown policy") throw new Error("provider detail must stay private");
    return { schemaVersion: 1, kind: "handoff", reason: "callerRequested" };
  } });
  const results = await runModelEvaluation(corpus, ingress, "prompt-v1", 2, 2);
  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => [result.caseId, result.repeat, result.verdict]), [
    ["case-a", 1, "match"], ["case-a", 2, "match"],
    ["case-b", 1, "providerFailure"], ["case-b", 2, "providerFailure"],
  ]);
  assert.equal(JSON.stringify(results).includes("provider detail"), false);
});

test("multi-turn evaluation sends only bounded prior caller text and current turn", async () => {
  const corpus = parseEvaluationCorpus(JSON.parse(await readFile("eval/model-multiturn-v1.json", "utf8")) as unknown);
  const seen: string[][] = [];
  const ingress = new ModelIngress({ async propose(input) {
    seen.push([...(input.priorCallerTurns ?? []), input.turn.text]);
    return { schemaVersion: 1, kind: "handoff", reason: "unsupported" };
  } });
  const results = await runModelEvaluation(corpus, ingress, "prompt-v3", 1, 4);
  assert.equal(results.length, 7);
  assert.equal(seen.every(turns => turns.length === 2), true);
  assert.equal(JSON.stringify(results).includes("Alex"), false);
});
