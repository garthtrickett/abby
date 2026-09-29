import type { TranscriptionPort } from "./media-turn-controller.ts";
import type { SpeechSynthesisPort } from "./streamed-playback-port.ts";
import { runTranscriptionEvaluation } from "./transcription-evaluation.ts";
import type { TranscriptionEvaluationResult } from "./transcription-evaluation.ts";

export type SpeechLoopCase = Readonly<{
  id: string;
  category: string;
  text: string;
  criticalTerms: readonly string[];
}>;
export type SpeechLoopCorpus = Readonly<{
  schemaVersion: 1;
  version: string;
  cases: readonly SpeechLoopCase[];
}>;
export type SpeechLoopResult = TranscriptionEvaluationResult & Readonly<{
  synthesisChunks: number;
  synthesisBytes: number;
  synthesisFirstChunkMs: number | null;
  synthesisMs: number | null;
  peakSample: number;
  failedStage: "synthesis" | "transcription" | null;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Fixed, patient-free text: the runner cannot read arbitrary caller audio or patient records. */
export function parseSpeechLoopCorpus(raw: unknown): SpeechLoopCorpus {
  const corpus = record(raw);
  if (!corpus || Object.keys(corpus).sort().join(",") !== "cases,schemaVersion,version" ||
      corpus.schemaVersion !== 1 || typeof corpus.version !== "string" ||
      !/^[a-z0-9-]{1,128}$/.test(corpus.version) || !Array.isArray(corpus.cases) ||
      corpus.cases.length < 1 || corpus.cases.length > 10) throw new Error("invalid speech loop corpus");
  const ids = new Set<string>();
  for (const rawCase of corpus.cases) {
    const item = record(rawCase);
    if (!item || Object.keys(item).sort().join(",") !== "category,criticalTerms,id,text" ||
        typeof item.id !== "string" || !/^SL-\d{3}$/.test(item.id) || ids.has(item.id) ||
        typeof item.category !== "string" || !/^[a-z-]{1,80}$/.test(item.category) ||
        typeof item.text !== "string" || !item.text.trim() || item.text.length > 500 ||
        /[\u0000-\u001f]/.test(item.text) || !Array.isArray(item.criticalTerms) ||
        item.criticalTerms.length < 1 || item.criticalTerms.length > 8 ||
        item.criticalTerms.some(term => typeof term !== "string" || !/^[A-Za-z]{2,30}$/.test(term) ||
          !words(item.text as string).includes(term.toLowerCase())) ||
        new Set(item.criticalTerms.map(term => String(term).toLowerCase())).size !== item.criticalTerms.length) {
      throw new Error("invalid speech loop case");
    }
    ids.add(item.id);
  }
  return raw as SpeechLoopCorpus;
}

function peakSample(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  for (let offset = 0; offset < pcm.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  }
  return peak;
}

/** Exercises live synthesis and transcription adapters together without storing generated audio. */
export async function runSpeechLoopEvaluation(corpus: SpeechLoopCorpus, synthesis: SpeechSynthesisPort,
                                              transcription: (sessionId: string) => TranscriptionPort,
                                              repeats = 2, concurrency = 2, paceMs = 20): Promise<readonly SpeechLoopResult[]> {
  parseSpeechLoopCorpus(corpus);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4 ||
      !Number.isSafeInteger(paceMs) || paceMs < 0 || paceMs > 20) throw new Error("invalid speech loop run");
  const jobs = corpus.cases.flatMap(item => Array.from({ length: repeats }, (_, index) => ({ item, repeat: index + 1 })));
  const results = new Array<SpeechLoopResult>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const { item, repeat } = job;
      const started = performance.now();
      let chunks = 0;
      let bytes = 0;
      let firstChunkMs: number | null = null;
      let synthesisMs: number | null = null;
      let peak = 0;
      let transcribed: TranscriptionEvaluationResult | undefined;
      let failedStage: SpeechLoopResult["failedStage"] = "synthesis";
      try {
        const audio: Uint8Array[] = [];
        for await (const chunk of synthesis.stream(item.text, AbortSignal.timeout(30_000))) {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength < 320 || chunk.byteLength > 3_200 ||
              chunk.byteLength % 32 !== 0 || bytes + chunk.byteLength > 1_000_000) {
            throw new Error("invalid synthesis audio");
          }
          if (firstChunkMs === null) firstChunkMs = Math.round(performance.now() - started);
          audio.push(chunk);
          chunks += 1;
          bytes += chunk.byteLength;
        }
        synthesisMs = Math.round(performance.now() - started);
        if (bytes < 640) throw new Error("empty synthesis audio");
        const pcm = Buffer.concat(audio);
        peak = peakSample(pcm);
        if (peak === 0) throw new Error("silent synthesis audio");
        failedStage = "transcription";
        const matches = await runTranscriptionEvaluation([{ id: item.id, category: item.category,
          expectedText: item.text, criticalTerms: item.criticalTerms, pcm }], transcription, 1, 1, paceMs);
        transcribed = matches[0];
        if (transcribed?.verdict !== "providerFailure") failedStage = null;
      } catch { /* A failed provider stage is reported, never promoted to a match. */ }
      results[index] = {
        caseId: item.id, category: item.category, repeat,
        verdict: transcribed?.verdict ?? "providerFailure", actualText: transcribed?.actualText ?? "",
        totalMs: Math.round(performance.now() - started), finalMs: transcribed?.finalMs ?? null,
        quality: transcribed?.quality ?? "unavailable", synthesisChunks: chunks, synthesisBytes: bytes,
        synthesisFirstChunkMs: firstChunkMs, synthesisMs, peakSample: peak, failedStage,
      };
    }
  }));
  return results;
}
