import type { TranscriptionEvaluationCase, TranscriptionEvaluationResult } from "./transcription-evaluation.ts";

export type TranscriptionGateThresholds = Readonly<{
  version: "transcription-synthetic-gate-v1";
  minRepeatsPerCase: number;
  maxCritical: number;
  maxProviderFailures: number;
  maxEmpty: number;
  maxTruncated: number;
  maxWordErrorRate: number;
  maxFinalP95Ms: number;
  maxIndividualFinalMs: number;
}>;
export const transcriptionSyntheticGateV1: TranscriptionGateThresholds = {
  version: "transcription-synthetic-gate-v1", minRepeatsPerCase: 3,
  maxCritical: 0, maxProviderFailures: 0, maxEmpty: 0, maxTruncated: 0,
  maxWordErrorRate: 0.1, maxFinalP95Ms: 2_500, maxIndividualFinalMs: 5_000,
};

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
function edits(expected: readonly string[], actual: readonly string[]): number {
  let row = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let left = 1; left <= expected.length; left += 1) {
    const next = [left];
    for (let right = 1; right <= actual.length; right += 1) {
      next.push(Math.min(next[right - 1]! + 1, row[right]! + 1,
        row[right - 1]! + (expected[left - 1] === actual[right - 1] ? 0 : 1)));
    }
    row = next;
  }
  return row[actual.length]!;
}
function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}

/** Candidate rejection gate for synthetic audio. It never grants real-call or patient-action readiness. */
export function assessSyntheticTranscription(cases: readonly Pick<TranscriptionEvaluationCase,
  "id" | "expectedText" | "criticalTerms">[], results: readonly TranscriptionEvaluationResult[],
  thresholds: TranscriptionGateThresholds = transcriptionSyntheticGateV1) {
  if (!cases.length || new Set(cases.map(item => item.id)).size !== cases.length ||
      !Number.isSafeInteger(thresholds.minRepeatsPerCase) || thresholds.minRepeatsPerCase < 1) {
    throw new Error("invalid transcription gate input");
  }
  const caseById = new Map(cases.map(item => [item.id, item]));
  const repeats = new Map(cases.map(item => [item.id, new Set<number>()]));
  let referenceWords = 0;
  let editCount = 0;
  let empty = 0;
  let truncated = 0;
  let critical = 0;
  let providerFailures = 0;
  let delayed = 0;
  const finalTimes: number[] = [];
  for (const result of results) {
    const item = caseById.get(result.caseId);
    const seen = repeats.get(result.caseId);
    if (!item || !seen || !Number.isSafeInteger(result.repeat) || result.repeat < 1 || seen.has(result.repeat)) {
      throw new Error("invalid transcription gate result");
    }
    if (!["match", "mismatch", "critical", "providerFailure"].includes(result.verdict) ||
        typeof result.actualText !== "string" ||
        !["needsClarification", "unavailable"].includes(result.quality) ||
        (result.finalMs !== null && (!Number.isFinite(result.finalMs) || result.finalMs < 0))) {
      throw new Error("invalid transcription gate result");
    }
    seen.add(result.repeat);
    if (result.verdict === "providerFailure") { providerFailures += 1; continue; }
    if (result.quality !== "needsClarification" || result.finalMs === null ||
        !Number.isFinite(result.finalMs) || result.finalMs < 0) throw new Error("invalid final evidence");
    const expected = words(item.expectedText);
    const actual = words(result.actualText);
    if (result.verdict === "critical" ||
        item.criticalTerms.some(term => !actual.includes(term.toLowerCase()))) critical += 1;
    if (!actual.length) empty += 1;
    if (actual.length + 1 < expected.length &&
        actual.every((word, index) => word === expected[index])) truncated += 1;
    referenceWords += expected.length;
    editCount += edits(expected, actual);
    finalTimes.push(result.finalMs);
    if (result.finalMs > thresholds.maxIndividualFinalMs) delayed += 1;
  }
  const missingRepeats = [...repeats].filter(([, values]) => values.size < thresholds.minRepeatsPerCase)
    .map(([id]) => id);
  const wordErrorRate = referenceWords ? editCount / referenceWords : null;
  const finalP95Ms = percentile(finalTimes, 0.95);
  const failures = [
    ...(missingRepeats.length ? ["insufficientRepeats"] : []),
    ...(critical > thresholds.maxCritical ? ["critical"] : []),
    ...(providerFailures > thresholds.maxProviderFailures ? ["providerFailure"] : []),
    ...(empty > thresholds.maxEmpty ? ["empty"] : []),
    ...(truncated > thresholds.maxTruncated ? ["truncated"] : []),
    ...(wordErrorRate === null || wordErrorRate > thresholds.maxWordErrorRate ? ["wordErrorRate"] : []),
    ...(finalP95Ms === null || finalP95Ms > thresholds.maxFinalP95Ms ? ["finalP95"] : []),
    ...(delayed ? ["delayed"] : []),
  ];
  return { status: failures.length ? "fail" as const : "pass" as const, failures,
    metrics: { cases: cases.length, runs: results.length, critical, providerFailures, empty,
      truncated, delayed, wordErrorRate, finalP95Ms, missingRepeats }, thresholds };
}
