import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { TranscriptionPort } from "./media-turn-controller.ts";

export type TranscriptionEvaluationCase = Readonly<{
  id: string;
  category: string;
  expectedText: string;
  criticalTerms: readonly string[];
  pcm: Uint8Array;
}>;

export type TranscriptionEvaluationCorpus = Readonly<{
  schemaVersion: 1;
  version: string;
  audioFormat: "mono-pcm16le-16000";
  cases: readonly Readonly<Omit<TranscriptionEvaluationCase, "pcm"> & {
    file: string;
    sha256: string;
  }>[];
}>;

export type TranscriptionEvaluationResult = Readonly<{
  caseId: string;
  category: string;
  repeat: number;
  verdict: "match" | "mismatch" | "critical" | "providerFailure";
  actualText: string;
  totalMs: number;
  finalMs: number | null;
  quality: "needsClarification" | "unavailable";
}>;

const frameBytes = 640; // 20 ms of mono signed PCM16 at 16 kHz.

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** A fixed synthetic corpus prevents the live runner from reading arbitrary caller audio. */
export function parseTranscriptionEvaluationCorpus(raw: unknown): TranscriptionEvaluationCorpus {
  const corpus = record(raw);
  if (!corpus || Object.keys(corpus).sort().join(",") !== "audioFormat,cases,schemaVersion,version" ||
      corpus.schemaVersion !== 1 || corpus.audioFormat !== "mono-pcm16le-16000" ||
      typeof corpus.version !== "string" || !/^[a-z0-9-]{1,128}$/.test(corpus.version) ||
      !Array.isArray(corpus.cases) || corpus.cases.length < 1 || corpus.cases.length > 20) {
    throw new Error("invalid transcription evaluation corpus");
  }
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const rawCase of corpus.cases) {
    const item = record(rawCase);
    const expectedWords = typeof item?.expectedText === "string" ? words(item.expectedText) : [];
    if (!item || Object.keys(item).sort().join(",") !== "category,criticalTerms,expectedText,file,id,sha256" ||
        typeof item.id !== "string" || !/^[A-Z]{2}-\d{3}$/.test(item.id) || ids.has(item.id) ||
        typeof item.category !== "string" || !/^[a-z-]{1,80}$/.test(item.category) ||
        typeof item.file !== "string" || !/^[a-z0-9-]+\.pcm$/.test(item.file) || files.has(item.file) ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        typeof item.expectedText !== "string" || !item.expectedText.trim() || item.expectedText.length > 500 ||
        !Array.isArray(item.criticalTerms) || item.criticalTerms.length < 1 || item.criticalTerms.length > 8 ||
        item.criticalTerms.some(term => typeof term !== "string" || !/^[A-Za-z]{2,30}$/.test(term) ||
          !expectedWords.includes(term.toLowerCase()))) {
      throw new Error("invalid transcription evaluation case");
    }
    ids.add(item.id);
    files.add(item.file);
  }
  return raw as TranscriptionEvaluationCorpus;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Replays only synthetic, bounded PCM through the same Realtime adapter used by a call. */
export async function runTranscriptionEvaluation(cases: readonly TranscriptionEvaluationCase[],
                                                 factory: (sessionId: string) => TranscriptionPort,
                                                 repeats = 3, concurrency = 2, paceMs = 20):
  Promise<readonly TranscriptionEvaluationResult[]> {
  if (!cases.length || cases.length > 20 || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isSafeInteger(paceMs) || paceMs < 0 || paceMs > 20 ||
      cases.some(item => !item.id || !item.expectedText || item.pcm.length < frameBytes ||
        item.pcm.length > 1_000_000 || item.pcm.length % 2 !== 0)) throw new Error("invalid transcription evaluation run");
  const jobs = cases.flatMap(item => Array.from({ length: repeats }, (_, index) => ({ item, repeat: index + 1 })));
  const results = new Array<TranscriptionEvaluationResult>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const { item, repeat } = job;
      const sessionId = randomUUID();
      const started = performance.now();
      let finalStarted = 0;
      let actualText = "";
      let quality: TranscriptionEvaluationResult["quality"] = "unavailable";
      let verdict: TranscriptionEvaluationResult["verdict"] = "providerFailure";
      let port: TranscriptionPort | undefined;
      try {
        port = factory(sessionId);
        const signal = AbortSignal.timeout(30_000);
        let accepted = true;
        for (let offset = 0, sequence = 0; offset < item.pcm.length; offset += frameBytes, sequence += 1) {
          const bytes = new Uint8Array(frameBytes);
          bytes.set(item.pcm.subarray(offset, offset + frameBytes));
          const result = await port.accept({ sessionId, sequence,
            capturedAt: new Date().toISOString(), bytes }, 1, signal);
          if (!result.ok) { accepted = false; break; }
          if (paceMs) await wait(paceMs, undefined, { signal });
        }
        if (accepted) {
          finalStarted = performance.now();
          const final = await port.flush(1, signal);
          const events = final.ok ? final.value.filter(event => event.kind === "segmentFinal") : [];
          if (events.length === 1 && events[0]?.sessionId === sessionId &&
              events[0].generation === 1 && events[0].quality === "needsClarification") {
            actualText = events[0].text;
            quality = "needsClarification";
            const actualWords = words(actualText);
            const expectedWords = words(item.expectedText);
            verdict = actualWords.join(" ") === expectedWords.join(" ") ? "match" :
              item.criticalTerms.some(term => !actualWords.includes(term.toLowerCase())) ? "critical" : "mismatch";
          }
        }
      } catch { /* A failed provider session is a reported failure, never a synthetic match. */ }
      finally { try { await port?.close?.(); } catch { /* Closing cannot erase a measured outcome. */ } }
      results[index] = { caseId: item.id, category: item.category, repeat, verdict, actualText,
        totalMs: Math.round(performance.now() - started),
        finalMs: finalStarted ? Math.round(performance.now() - finalStarted) : null, quality };
    }
  }));
  return results;
}
