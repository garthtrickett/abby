import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { OpenAIRealtimeTranscription } from "../src/voice/openai-realtime-transcription.ts";
import { OpenAISpeechSynthesis } from "../src/voice/openai-speech-synthesis.ts";
import { parseSpeechLoopCorpus, runSpeechLoopEvaluation } from "../src/voice/speech-loop-evaluation.ts";

function argsFrom(argv: readonly string[]): Record<string, string> {
  const allowed = new Set(["out", "repeats", "concurrency", "speech-model", "voice"]);
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
  const corpusBytes = await readFile(resolve("eval/speech-loop-v1.json"));
  const corpus = parseSpeechLoopCorpus(JSON.parse(corpusBytes.toString("utf8")) as unknown);
  const repeats = args.repeats === undefined ? 2 : Number(args.repeats);
  const concurrency = args.concurrency === undefined ? 2 : Number(args.concurrency);
  const speechModel = args["speech-model"] ?? "gpt-4o-mini-tts";
  const voice = args.voice ?? "coral";
  const synthesis = new OpenAISpeechSynthesis({ apiKey, model: speechModel, voice });
  const results = await runSpeechLoopEvaluation(corpus, synthesis,
    sessionId => new OpenAIRealtimeTranscription({ apiKey, sessionId }), repeats, concurrency);
  const counts = { match: 0, mismatch: 0, critical: 0, providerFailure: 0 };
  for (const result of results) counts[result.verdict] += 1;
  const sourcePaths = ["src/voice/openai-speech-synthesis.ts", "src/voice/openai-realtime-transcription.ts",
    "src/voice/transcription-evaluation.ts", "src/voice/speech-loop-evaluation.ts",
    "scripts/evaluate-speech-loop.ts"];
  const sourceBytes = await Promise.all(sourcePaths.map(path => readFile(resolve(path))));
  const report = { schemaVersion: 1, kind: "speech-loop-evaluation", runAt: new Date().toISOString(),
    configuration: { speechModel, voice, transcriptionModel: "gpt-live-transcribe",
      corpusVersion: corpus.version, corpusSha256: digest(corpusBytes),
      adapterSha256: digest(Buffer.concat(sourceBytes)), nodeVersion: process.version,
      repeats, concurrency, audioFormat: "mono-pcm16le-16000" },
    counts, results, humanReviewStatus: "pending", phoneCallStatus: "notRun", releaseGate: "unverified" };
  const output = resolve(args.out!);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ counts, output, releaseGate: report.releaseGate })}\n`);
  if (counts.critical || counts.mismatch || counts.providerFailure) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Speech loop evaluation could not run; check arguments, configuration, and corpus.\n");
  process.exitCode = 1;
});
