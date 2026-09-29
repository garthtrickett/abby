import type { FinalCallerTurn } from "../core/model.ts";
import type { IntentResolver, VoiceIntent } from "../voice/voice-session.ts";

export type AvailabilityExpectation =
  | Readonly<{ kind: "availability"; from: string; to: string }>
  | Readonly<{ kind: "unsupported" }>;
export type AvailabilityEvaluationCase = Readonly<{
  id: string;
  category: string;
  callerText: string;
  expected: AvailabilityExpectation;
  criticalIfMissed: boolean;
}>;
export type AvailabilityEvaluationCorpus = Readonly<{
  schemaVersion: 1;
  version: string;
  clinicDate: string;
  cases: readonly AvailabilityEvaluationCase[];
}>;
export type AvailabilityEvaluationResult = Readonly<{
  caseId: string;
  repeat: number;
  elapsedMs: number;
  verdict: "match" | "mismatch" | "critical" | "providerFailure";
  actual: "availability" | "unsupported" | "other" | "unavailable";
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function bounded(value: unknown, limit: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= limit;
}

function dateMillis(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : undefined;
}

/** Fails before an API call if the synthetic fixture or its expected date is ambiguous. */
export function parseAvailabilityEvaluationCorpus(raw: unknown): AvailabilityEvaluationCorpus {
  const value = record(raw);
  if (!value || value.schemaVersion !== 1 || !bounded(value.version, 128) ||
      dateMillis(value.clinicDate) === undefined || !Array.isArray(value.cases) ||
      value.cases.length < 1 || value.cases.length > 200) throw new Error("invalid availability evaluation corpus");
  const ids = new Set<string>();
  const today = dateMillis(value.clinicDate)!;
  for (const item of value.cases) {
    const scenario = record(item);
    if (!scenario || !bounded(scenario.id, 128) || ids.has(scenario.id) ||
        !bounded(scenario.category, 80) || !bounded(scenario.callerText, 4_000) ||
        typeof scenario.criticalIfMissed !== "boolean") throw new Error("invalid availability evaluation case");
    ids.add(scenario.id);
    const expected = record(scenario.expected);
    if (!expected || (expected.kind !== "unsupported" && expected.kind !== "availability")) {
      throw new Error("invalid availability expectation");
    }
    if (expected.kind === "unsupported") {
      if (Object.keys(expected).length !== 1) throw new Error("invalid availability expectation");
    } else {
      const from = dateMillis(expected.from);
      const to = dateMillis(expected.to);
      if (Object.keys(expected).sort().join(",") !== "from,kind,to" || from === undefined || to === undefined ||
          from < today || to < from || to - from > 7 * 86_400_000) throw new Error("invalid availability expectation");
    }
  }
  return raw as AvailabilityEvaluationCorpus;
}

function matches(expected: AvailabilityExpectation, actual: VoiceIntent): boolean {
  return expected.kind === "unsupported" ? actual.kind === "model" :
    actual.kind === "availability" && actual.from === expected.from && actual.to === expected.to;
}

/** Repeats independent clear-turn cases in parallel without persisting caller text in the result. */
export async function runAvailabilityIntentEvaluation(corpus: AvailabilityEvaluationCorpus, resolve: IntentResolver,
                                                       repeats = 3, concurrency = 4): Promise<readonly AvailabilityEvaluationResult[]> {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 || !Number.isSafeInteger(concurrency) ||
      concurrency < 1 || concurrency > 8) throw new Error("invalid availability evaluation run");
  const jobs = corpus.cases.flatMap(scenario => Array.from({ length: repeats }, (_, index) => ({ scenario, repeat: index + 1 })));
  const results = new Array<AvailabilityEvaluationResult>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const { scenario, repeat } = job;
      const turn: FinalCallerTurn = { callId: `eval-${index}`, turnId: `eval-${index}`,
        text: scenario.callerText, quality: "clear", at: `${corpus.clinicDate}T00:00:00.000Z` };
      const started = performance.now();
      let result: Awaited<ReturnType<IntentResolver>>;
      try { result = await resolve(turn); }
      catch { result = { ok: false, error: { kind: "intentUnavailable" } }; }
      const elapsedMs = Math.round(performance.now() - started);
      if (!result.ok) {
        results[index] = { caseId: scenario.id, repeat, elapsedMs, verdict: "providerFailure", actual: "unavailable" };
      } else {
        const matched = matches(scenario.expected, result.value);
        results[index] = { caseId: scenario.id, repeat, elapsedMs,
          verdict: matched ? "match" : scenario.criticalIfMissed ? "critical" : "mismatch",
          actual: result.value.kind === "availability" ? "availability" :
            result.value.kind === "model" ? "unsupported" : "other" };
      }
    }
  }));
  return results;
}
