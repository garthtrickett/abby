import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OpenAIRealtimeTranscription } from "../src/voice/openai-realtime-transcription.ts";
import { parseTranscriptionEvaluationCorpus, runTranscriptionEvaluation } from "../src/voice/transcription-evaluation.ts";
import type { TranscriptionEvaluationCase } from "../src/voice/transcription-evaluation.ts";

function argsFrom(argv: readonly string[]): Record<string, string> {
  const allowed = new Set(["out", "repeats", "concurrency", "corpus"]);
  const args: Record<string, string> = {};
  if (argv.length % 2 !== 0) throw new Error("invalid evaluation arguments");
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const key = flag?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !key || !allowed.has(key) || !value || args[key] !== undefined) {
      throw new Error("invalid evaluation arguments");
    }
    args[key] = value;
  }
  if (!args.out?.trim()) throw new Error("missing --out");
  return args;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  const args = argsFrom(process.argv.slice(2));
  const apiKey = process.env.ABBY_OPENAI_API_KEY;
  if (!apiKey) throw new Error("ABBY_OPENAI_API_KEY is required");
  const corpusName = args.corpus ?? "transcription-v1";
  if (corpusName !== "transcription-v1" && corpusName !== "transcription-telephony-v1") {
    throw new Error("unsupported transcription evaluation corpus");
  }
  const corpusBytes = await readFile(resolve(`eval/${corpusName}.json`));
  const corpus = parseTranscriptionEvaluationCorpus(JSON.parse(corpusBytes.toString("utf8")) as unknown);
  const cases: TranscriptionEvaluationCase[] = await Promise.all(corpus.cases.map(async item => {
    const pcm = await readFile(resolve("eval/audio", item.file));
    if (digest(pcm) !== item.sha256) throw new Error("transcription fixture changed");
    return { id: item.id, category: item.category, expectedText: item.expectedText,
      criticalTerms: item.criticalTerms, pcm };
  }));
  const repeats = args.repeats === undefined ? 3 : Number(args.repeats);
  const concurrency = args.concurrency === undefined ? 2 : Number(args.concurrency);
  const results = await runTranscriptionEvaluation(cases,
    sessionId => new OpenAIRealtimeTranscription({ apiKey, sessionId }), repeats, concurrency);
  const counts = { match: 0, mismatch: 0, critical: 0, providerFailure: 0 };
  for (const result of results) counts[result.verdict] += 1;
  const sourcePaths = ["src/voice/openai-realtime-transcription.ts", "src/voice/transcription-evaluation.ts",
    "scripts/evaluate-transcription.ts"];
  const sourceBytes = await Promise.all(sourcePaths.map(path => readFile(resolve(path))));
  const report = { schemaVersion: 1, kind: "realtime-transcription-evaluation", runAt: new Date().toISOString(),
    configuration: { provider: "openai-realtime", model: "gpt-live-transcribe", corpusVersion: corpus.version,
      corpusSha256: digest(corpusBytes), adapterSha256: digest(Buffer.concat(sourceBytes)), nodeVersion: process.version,
      repeats, concurrency, audioFormat: corpus.audioFormat },
    counts, results, humanReviewStatus: "pending", liveCallStatus: "notRun", releaseGate: "unverified" };
  const output = resolve(args.out!);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ counts, output, releaseGate: report.releaseGate })}\n`);
  if (counts.critical || counts.mismatch || counts.providerFailure) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Realtime transcription evaluation could not run; check arguments, configuration, and fixtures.\n");
  process.exitCode = 1;
});
