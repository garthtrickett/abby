import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessSyntheticSpeechLatency } from "../src/voice/speech-latency-gate.ts";
import type { SpeechLatencySample } from "../src/voice/speech-latency-gate.ts";
import { parseSpeechLoopCorpus } from "../src/voice/speech-loop-evaluation.ts";
import { assessSyntheticTranscription } from "../src/voice/transcription-evaluation-gate.ts";
import { parseTranscriptionEvaluationCorpus } from "../src/voice/transcription-evaluation.ts";
import type { TranscriptionEvaluationResult } from "../src/voice/transcription-evaluation.ts";

const names = ["telephony", "noise", "safety", "speech"] as const;
const speechProfiles = {
  default: { primaryModel: "gpt-4o-mini-tts", fallbackModel: "tts-1", primaryFirstChunkMs: 1_500 },
  "tts-1-primary-v1": { primaryModel: "tts-1", fallbackModel: "tts-1", primaryFirstChunkMs: 2_500 },
} as const;
export type SpeechProfile = keyof typeof speechProfiles;
export type SpeechReportPaths = Readonly<Record<typeof names[number], string>>;
const transcriptionSources = ["src/voice/openai-realtime-transcription.ts",
  "src/voice/transcription-evaluation.ts", "src/voice/transcription-evaluation-gate.ts",
  "scripts/evaluate-transcription.ts"];
const speechSources = ["src/voice/openai-speech-synthesis.ts",
  "src/voice/first-chunk-fallback-speech.ts", "src/voice/streamed-playback-port.ts",
  "src/voice/speech-latency-gate.ts", "scripts/evaluate-first-chunk-fallback.ts"];

function argsFrom(argv: readonly string[]): SpeechReportPaths & Readonly<{
  speechProfile: SpeechProfile; recordCurrent?: string }> {
  if (argv.length < names.length * 2 || argv.length > names.length * 2 + 4 || argv.length % 2 !== 0) {
    throw new Error("four report paths required");
  }
  const args: Partial<Record<typeof names[number] | "speech-profile" | "record-current", string>> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "") as typeof names[number] | "speech-profile" | "record-current";
    const path = argv[index + 1];
    if (!argv[index]?.startsWith("--") || (key !== "speech-profile" && key !== "record-current" && !names.includes(key)) ||
        !path || args[key]) {
      throw new Error("invalid report argument");
    }
    args[key] = path;
  }
  if (names.some(name => !args[name]) ||
      (args["speech-profile"] !== undefined && !Object.hasOwn(speechProfiles, args["speech-profile"]))) {
    throw new Error("missing report or invalid speech profile");
  }
  return { telephony: args.telephony!, noise: args.noise!, safety: args.safety!, speech: args.speech!,
    speechProfile: (args["speech-profile"] ?? "default") as SpeechProfile,
    ...(args["record-current"] ? { recordCurrent: args["record-current"] } : {}) };
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

export async function assessSpeechReports(args: SpeechReportPaths & Readonly<{ speechProfile: SpeechProfile }>) {
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
        config.model !== "gpt-live-transcribe" || config.contextVersion !== undefined ||
        config.delay !== undefined || config.noiseReduction !== undefined ||
        !Array.isArray(current.results)) {
      throw new Error(`${name} report does not match current candidate`);
    }
    const assessment = assessSyntheticTranscription(corpus.cases,
      current.results as TranscriptionEvaluationResult[]);
    summaries.push({ name, status: assessment.status, failures: assessment.failures,
      metrics: assessment.metrics });
  }
  const current = await report(args.speech);
  const config = object(current.configuration);
  const profile = speechProfiles[args.speechProfile];
  const speechCorpus = await readFile(resolve("eval/speech-loop-v1.json"));
  const parsedSpeechCorpus = parseSpeechLoopCorpus(JSON.parse(speechCorpus.toString("utf8")) as unknown);
  if (current.kind !== "speech-first-chunk-fallback-evaluation" ||
      config.corpusVersion !== "speech-loop-v1" || config.corpusSha256 !== digest(speechCorpus) ||
      config.sourceSha256 !== speechHash || config.primaryModel !== profile.primaryModel ||
      config.fallbackModel !== profile.fallbackModel ||
      config.primaryFirstChunkMs !== profile.primaryFirstChunkMs ||
      config.voice !== "coral" || config.combinedFirstChunkMs !== 5_000 ||
      config.laterStepMs !== 2_000 || config.maxUtteranceMs !== 20_000 ||
      config.repeats !== 20 || !Number.isSafeInteger(config.concurrency) ||
      (config.concurrency as number) < 1 || (config.concurrency as number) > 4 ||
      !Array.isArray(current.results)) {
    throw new Error("speech report does not match current candidate");
  }
  const speech = assessSyntheticSpeechLatency(current.results as SpeechLatencySample[],
    parsedSpeechCorpus.cases.map(item => item.id));
  summaries.push({ name: "speech", status: speech.status, failures: speech.failures, metrics: speech.metrics });
  const status = summaries.every(item => item.status === "pass") ? "pass" : "fail";
  return { speechProfile: args.speechProfile,
    syntheticCandidateGate: status, checks: summaries,
    representativeCallGate: "notRun" as const, releaseGate: "unverified" as const };
}

async function main(): Promise<void> {
  const args = argsFrom(process.argv.slice(2));
  const summary = await assessSpeechReports(args);
  if (args.recordCurrent) {
    const target = resolve(args.recordCurrent);
    const temporary = resolve(dirname(target), `.speech-gate-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, speechProfile: args.speechProfile,
        reports: Object.fromEntries(names.map(name => [name, resolve(args[name])])) })}\n`,
      { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.syntheticCandidateGate !== "pass") process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.stderr.write("Speech evaluation reports are missing, stale, or invalid.\n");
    process.exitCode = 1;
  });
}
