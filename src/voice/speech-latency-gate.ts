export type SpeechLatencySample = Readonly<{
  caseId: string;
  repeat: number;
  outcome: "queued" | "notSent" | "uncertain";
  chunks: number;
  firstChunkMs: number | null;
  totalMs: number;
}>;
export const speechLatencyThresholdsV1 = {
  version: "speech-synthetic-latency-v1", minJobs: 40, repeatsPerCase: 20,
  maxP95FirstChunkMs: 3_500, maxIndividualFirstChunkMs: 5_000,
  maxP95UtteranceMs: 6_000, maxFailedJobs: 0,
} as const;

function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}

/** Measures queue timing only. A separate carrier run must prove audible speech latency. */
export function assessSyntheticSpeechLatency(samples: readonly SpeechLatencySample[], caseIds: readonly string[]) {
  if (caseIds.length !== 2 || new Set(caseIds).size !== caseIds.length ||
      caseIds.some(id => typeof id !== "string" || !id)) throw new Error("invalid speech latency corpus");
  if (samples.some(item => typeof item.caseId !== "string" ||
      !Number.isSafeInteger(item.repeat) ||
      !["queued", "notSent", "uncertain"].includes(item.outcome) ||
      !Number.isSafeInteger(item.chunks) || item.chunks < 0 ||
      !Number.isFinite(item.totalMs) || item.totalMs < 0 ||
      (item.firstChunkMs !== null && (!Number.isFinite(item.firstChunkMs) || item.firstChunkMs < 0)))) {
    throw new Error("invalid speech latency sample");
  }
  const failedJobs = samples.filter(item => item.outcome !== "queued" || item.chunks < 1 ||
    item.firstChunkMs === null).length;
  const queued = samples.filter(item => item.outcome === "queued" && item.chunks > 0 &&
    item.firstChunkMs !== null);
  const firstChunkP95Ms = percentile(queued.map(item => item.firstChunkMs!), 0.95);
  const utteranceP95Ms = percentile(queued.map(item => item.totalMs), 0.95);
  const lateJobs = queued.filter(item => item.firstChunkMs! > speechLatencyThresholdsV1.maxIndividualFirstChunkMs).length;
  const expected = new Set(caseIds.flatMap(caseId => Array.from(
    { length: speechLatencyThresholdsV1.repeatsPerCase }, (_, index) => `${caseId}:${index + 1}`)));
  const observed = samples.map(item => `${item.caseId}:${item.repeat}`);
  const completeCorpus = samples.length === expected.size && new Set(observed).size === expected.size &&
    observed.every(key => expected.has(key));
  const failures = [
    ...(samples.length < speechLatencyThresholdsV1.minJobs ? ["insufficientJobs"] : []),
    ...(!completeCorpus ? ["corpusCoverage"] : []),
    ...(failedJobs > speechLatencyThresholdsV1.maxFailedJobs ? ["failedJobs"] : []),
    ...(firstChunkP95Ms === null || firstChunkP95Ms > speechLatencyThresholdsV1.maxP95FirstChunkMs
      ? ["firstChunkP95"] : []),
    ...(utteranceP95Ms === null || utteranceP95Ms > speechLatencyThresholdsV1.maxP95UtteranceMs
      ? ["utteranceP95"] : []),
    ...(lateJobs ? ["lateJobs"] : []),
  ];
  return { status: failures.length ? "fail" as const : "pass" as const, failures,
    metrics: { jobs: samples.length, failedJobs, lateJobs, firstChunkP95Ms, utteranceP95Ms },
    thresholds: speechLatencyThresholdsV1 };
}
