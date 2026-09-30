import { createHash } from "node:crypto";
import { ModelIngress, validPriorCallerTurns } from "./proposal.ts";
import type { ModelFailure, ModelInput, ModelProposal } from "./proposal.ts";

export type EvaluationExpectation = Readonly<{
  kind: ModelProposal["kind"];
  sourceRef?: string;
  target?: "patient" | "appointment" | "offer";
  operation?: "intake" | "book" | "cancel" | "reschedule";
  reason?: "callerRequested" | "unsupported";
}>;

export type EvaluationCase = Readonly<{
  id: string;
  category: string;
  callerText: string;
  priorCallerTurns?: readonly string[];
  knowledge: readonly Readonly<{ sourceRef: string; approvedText: string }>[];
  expected: readonly EvaluationExpectation[];
  criticalIfMissed?: boolean;
  requireOmittedRequestedTime?: boolean;
}>;

export type EvaluationCorpus = Readonly<{ schemaVersion: 1; version: string; cases: readonly EvaluationCase[] }>;
export type EvaluationResult = Readonly<{
  caseId: string;
  repeat: number;
  elapsedMs: number;
  verdict: "match" | "mismatch" | "critical" | "providerFailure";
  proposal?: ModelProposal;
  failure?: ModelFailure["kind"];
}>;

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}

/** Reject malformed or ambiguous fixtures before they consume provider calls. */
export function parseEvaluationCorpus(raw: unknown): EvaluationCorpus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid evaluation corpus");
  const corpus = raw as Record<string, unknown>;
  if (corpus.schemaVersion !== 1 || !bounded(corpus.version, 128) || !Array.isArray(corpus.cases) ||
      corpus.cases.length < 1 || corpus.cases.length > 200) throw new Error("invalid evaluation corpus");
  const ids = new Set<string>();
  for (const item of corpus.cases) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid evaluation case");
    const scenario = item as Record<string, unknown>;
    if (!bounded(scenario.id, 128) || ids.has(scenario.id) || !bounded(scenario.category, 80) ||
        !bounded(scenario.callerText, 4_000) || !Array.isArray(scenario.knowledge) || scenario.knowledge.length > 8 ||
        (scenario.priorCallerTurns !== undefined && !validPriorCallerTurns(scenario.priorCallerTurns)) ||
        !Array.isArray(scenario.expected) || scenario.expected.length < 1 || scenario.expected.length > 4 ||
        (scenario.criticalIfMissed !== undefined && typeof scenario.criticalIfMissed !== "boolean") ||
        (scenario.requireOmittedRequestedTime !== undefined && typeof scenario.requireOmittedRequestedTime !== "boolean")) {
      throw new Error("invalid evaluation case");
    }
    ids.add(scenario.id);
    const refs = new Set<string>();
    for (const value of scenario.knowledge) {
      if (!value || typeof value !== "object" || !bounded(value.sourceRef, 256) ||
          !bounded(value.approvedText, 2_000) || refs.has(value.sourceRef)) throw new Error("invalid evaluation knowledge");
      refs.add(value.sourceRef);
    }
    for (const value of scenario.expected) {
      if (!value || typeof value !== "object" || !["answer", "lookup", "action", "handoff"].includes(value.kind))
        throw new Error("invalid evaluation expectation");
      if (value.kind === "answer" && (!bounded(value.sourceRef, 256) || !refs.has(value.sourceRef)))
        throw new Error("invalid answer expectation");
      if (value.kind === "lookup" && !["patient", "appointment", "offer"].includes(value.target))
        throw new Error("invalid lookup expectation");
      if (value.kind === "action" && !["intake", "book", "cancel", "reschedule"].includes(value.operation))
        throw new Error("invalid action expectation");
      if (value.kind === "handoff" && !["callerRequested", "unsupported"].includes(value.reason))
        throw new Error("invalid handoff expectation");
    }
  }
  return raw as EvaluationCorpus;
}

function expectedMatches(scenario: EvaluationCase, proposal: ModelProposal): boolean {
  return scenario.expected.some(expected => {
    if (expected.kind !== proposal.kind) return false;
    switch (proposal.kind) {
      case "answer": return proposal.sourceRefs.length === 1 && proposal.sourceRefs[0] === expected.sourceRef &&
        scenario.knowledge.some(source => source.sourceRef === expected.sourceRef && source.approvedText === proposal.proposedText);
      case "lookup": return proposal.target === expected.target;
      case "action": return proposal.operation === expected.operation;
      case "handoff": return proposal.reason === expected.reason;
    }
  });
}

export function scoreEvaluation(scenario: EvaluationCase, proposal: ModelProposal): EvaluationResult["verdict"] {
  if (scenario.requireOmittedRequestedTime && proposal.kind === "action" && proposal.requestedTime !== undefined) {
    return "critical";
  }
  if (proposal.kind === "answer" && (proposal.sourceRefs.length !== 1 ||
      !scenario.knowledge.some(source => source.sourceRef === proposal.sourceRefs[0] && source.approvedText === proposal.proposedText)))
    return "critical";
  if (expectedMatches(scenario, proposal)) return "match";
  return scenario.criticalIfMissed ? "critical" : "mismatch";
}

/** Runs independent synthetic cases in parallel; a match still requires human review. */
export async function runModelEvaluation(corpus: EvaluationCorpus, ingress: ModelIngress, promptVersion: string,
                                         repeats = 3, concurrency = 4): Promise<readonly EvaluationResult[]> {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isSafeInteger(concurrency) ||
      concurrency < 1 || concurrency > 8 || !bounded(promptVersion, 128)) throw new Error("invalid evaluation run");
  const jobs = corpus.cases.flatMap(scenario => Array.from({ length: repeats }, (_, index) => ({ scenario, repeat: index + 1 })));
  const results = new Array<EvaluationResult>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const { scenario, repeat } = job;
      const taskId = createHash("sha256").update(`${corpus.version}:${scenario.id}:${repeat}`).digest("hex");
      const input: ModelInput = { scope: { tenantId: "eval", clinicId: "eval", locationId: "eval" },
        turn: { callId: taskId, turnId: taskId, text: scenario.callerText, quality: "clear", at: "2026-09-28T10:00:00.000Z" },
        ...(scenario.priorCallerTurns ? { priorCallerTurns: scenario.priorCallerTurns } : {}),
        knowledge: scenario.knowledge, conversationRevision: 1, policyVersion: "eval", promptVersion };
      const started = performance.now();
      const proposed = await ingress.propose(input, 10_000);
      const elapsedMs = Math.round(performance.now() - started);
      results[index] = proposed.ok
        ? { caseId: scenario.id, repeat, elapsedMs, verdict: scoreEvaluation(scenario, proposed.value), proposal: proposed.value }
        : { caseId: scenario.id, repeat, elapsedMs, verdict: "providerFailure", failure: proposed.error.kind };
    }
  }));
  return results;
}
