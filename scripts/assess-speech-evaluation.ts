import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessSyntheticSpeechLatency } from "../src/voice/speech-latency-gate.ts";
import type { SpeechLatencySample } from "../src/voice/speech-latency-gate.ts";
import { assessSyntheticTranscription } from "../src/voice/transcription-evaluation-gate.ts";
import { parseTranscriptionEvaluationCorpus } from "../src/voice/transcription-evaluation.ts";
import type { TranscriptionEvaluationResult } from "../src/voice/transcription-evaluation.ts";

const names = ["telephony", "noise", "safety", "speech"] as const;
const transcriptionSources = ["src/voice/openai-realtime-transcription.ts",
  "src/voice/transcription-evaluation.ts", "src/voice/transcription-evaluation-gate.ts",
  "scripts/evaluate-transcription.ts"];
const speechSources = ["src/voice/openai-speech-synthesis.ts",
  "src/voice/first-chunk-fallback-speech.ts", "src/voice/streamed-playback-port.ts",
  "src/voice/speech-latency-gate.ts", "scripts/evaluate-first-chunk-fallback.ts"];

function argsFrom(argv: readonly string[]): Record<typeof names[number], string> {
  if (argv.length !== names.length * 2) throw new Error("four report paths required");
  const args: Partial<Record<typeof names[number], string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "") as typeof names[number];
    const path = argv[index + 1];
    if (!argv[index]?.startsWith("--") || !names.includes(key) || !path || args[key]) {
      throw new Error("invalid report argument");
    }
    args[key] = path;
  }
  if (names.some(name => !args[name])) throw new Error("missing report");
  return args as Record<typeof names[number], string>;
}
function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
async function sourceHash(paths: readonly string[]): Promise<string> {
  const bytes = await Promise.all(paths.map(path => readFile(resolve(path))));
  return digest(Buffer.concat(bytes));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid evaluation report");
  return value as Record<string, unknown>;
}
async function report(path: string): Promise<Record<string, unknown>> {
  const parsed = object(JSON.parse(await readFile(resolve(path), "utf8")) as unknown);
  if (parsed.releaseGate !== "unverified") throw new Error("report claims an unsupported release gate");
  return parsed;
}

async function main(): Promise<void> {
  const args = argsFrom(process.argv.slice(2));
  const transcriptionHash = await sourceHash(transcriptionSources);
  const speechHash = await sourceHash(speechSources);
  const summaries = [];
  for (const [name, corpusName] of [
    ["telephony", "transcription-telephony-v1"],
    ["noise", "transcription-noise-v1"],
    ["safety", "transcription-safety-v1"],
  ] as const) {
    const current = await report(args[name]);
    const config = object(current.configuration);
    const corpusBytes = await readFile(resolve(`eval/${corpusName}.json`));
    const corpus = parseTranscriptionEvaluationCorpus(JSON.parse(corpusBytes.toString("utf8")) as unknown);
    if (current.kind !== "realtime-transcription-evaluation" || config.corpusVersion !== corpusName ||
        config.corpusSha256 !== digest(corpusBytes) || config.adapterSha256 !== transcriptionHash ||
        config.model !== "gpt-live-transcribe" || !Array.isArray(current.results)) {
      throw new Error(`${name} report does not match current candidate`);
    }
    const assessment = assessSyntheticTranscription(corpus.cases,
      current.results as TranscriptionEvaluationResult[]);
    summaries.push({ name, status: assessment.status, failures: assessment.failures,
      metrics: assessment.metrics });
  }
  const current = await report(args.speech);
  const config = object(current.configuration);
  const speechCorpus = await readFile(resolve("eval/speech-loop-v1.json"));
  if (current.kind !== "speech-first-chunk-fallback-evaluation" ||
      config.corpusVersion !== "speech-loop-v1" || config.corpusSha256 !== digest(speechCorpus) ||
      config.sourceSha256 !== speechHash || config.primaryModel !== "gpt-4o-mini-tts" ||
      config.fallbackModel !== "tts-1" || !Array.isArray(current.results)) {
    throw new Error("speech report does not match current candidate");
  }
  const speech = assessSyntheticSpeechLatency(current.results as SpeechLatencySample[]);
  summaries.push({ name: "speech", status: speech.status, failures: speech.failures, metrics: speech.metrics });
  const status = summaries.every(item => item.status === "pass") ? "pass" : "fail";
  process.stdout.write(`${JSON.stringify({ syntheticCandidateGate: status, checks: summaries,
    representativeCallGate: "notRun", releaseGate: "unverified" })}\n`);
  if (status !== "pass") process.exitCode = 1;
}
main().catch(() => {
  process.stderr.write("Speech evaluation reports are missing, stale, or invalid.\n");
  process.exitCode = 1;
});
