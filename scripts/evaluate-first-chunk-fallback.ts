import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FirstChunkFallbackSpeech } from "../src/voice/first-chunk-fallback-speech.ts";
import { OpenAISpeechSynthesis } from "../src/voice/openai-speech-synthesis.ts";
import { parseSpeechLoopCorpus } from "../src/voice/speech-loop-evaluation.ts";
import { assessSyntheticSpeechLatency } from "../src/voice/speech-latency-gate.ts";
import { StreamedPlaybackPort } from "../src/voice/streamed-playback-port.ts";

type Sample = Readonly<{ caseId: string; repeat: number; selected: "primary" | "fallback" | "none";
  outcome: "queued" | "notSent" | "uncertain"; chunks: number; firstChunkMs: number | null;
  totalMs: number }>;

function argsFrom(argv: readonly string[]): Record<string, string> {
  const allowed = new Set(["out", "repeats", "concurrency"]);
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
  const repeats = args.repeats === undefined ? 20 : Number(args.repeats);
  const concurrency = args.concurrency === undefined ? 2 : Number(args.concurrency);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("invalid evaluation limits");
  }
  const jobs = corpus.cases.flatMap(item => Array.from({ length: repeats }, (_, index) =>
    ({ item, repeat: index + 1 })));
  const results = new Array<Sample>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const started = performance.now();
      let selected: Sample["selected"] = "none";
      let chunks = 0;
      let firstChunkMs: number | null = null;
      let outcome: Sample["outcome"] = "notSent";
      try {
        const synthesis = new FirstChunkFallbackSpeech({
          primary: new OpenAISpeechSynthesis({ apiKey }),
          fallback: new OpenAISpeechSynthesis({ apiKey, model: "tts-1" }),
          primaryFirstChunkMs: 1_500,
          onSelection: source => { selected = source; },
        });
        const playback = new StreamedPlaybackPort(synthesis, {
          async queueChunk() {
            if (firstChunkMs === null) firstChunkMs = Math.round(performance.now() - started);
            chunks += 1;
            return "queued";
          },
          async finishQueue() { return "queued"; },
          async clear() { return true; },
        }, { firstChunkDeadlineMs: 5_000 });
        const expiresAt = started + 20_000;
        outcome = await playback.enqueue(`fallback-eval-${index}`, job.item.text,
          () => performance.now() < expiresAt);
      } catch { outcome = chunks ? "uncertain" : "notSent"; }
      results[index] = { caseId: job.item.id, repeat: job.repeat, selected, outcome, chunks,
        firstChunkMs, totalMs: Math.round(performance.now() - started) };
    }
  }));
  const queued = results.filter(item => item.outcome === "queued" && item.chunks > 0);
  const counts = { queued: queued.length, notSent: results.filter(item => item.outcome === "notSent").length,
    uncertain: results.filter(item => item.outcome === "uncertain").length,
    primary: results.filter(item => item.selected === "primary").length,
    fallback: results.filter(item => item.selected === "fallback").length,
    firstChunkMisses: results.filter(item => item.firstChunkMs === null || item.firstChunkMs > 5_000).length };
  const candidateGate = assessSyntheticSpeechLatency(results, corpus.cases.map(item => item.id));
  const sourcePaths = ["src/voice/openai-speech-synthesis.ts", "src/voice/first-chunk-fallback-speech.ts",
    "src/voice/streamed-playback-port.ts", "src/voice/speech-latency-gate.ts",
    "scripts/evaluate-first-chunk-fallback.ts"];
  const sourceBytes = await Promise.all(sourcePaths.map(path => readFile(resolve(path))));
  const report = { schemaVersion: 1, kind: "speech-first-chunk-fallback-evaluation",
    runAt: new Date().toISOString(), configuration: { primaryModel: "gpt-4o-mini-tts",
      fallbackModel: "tts-1", voice: "coral", primaryFirstChunkMs: 1_500,
      combinedFirstChunkMs: 5_000, laterStepMs: 2_000, maxUtteranceMs: 20_000,
      corpusVersion: corpus.version, corpusSha256: digest(corpusBytes),
      sourceSha256: digest(Buffer.concat(sourceBytes)), repeats, concurrency,
      nodeVersion: process.version }, counts, candidateGate,
    firstChunkP95AmongQueuedMs: candidateGate.metrics.firstChunkP95Ms,
    results, humanReviewStatus: "pending", liveCallStatus: "notRun", releaseGate: "unverified" };
  const output = resolve(args.out!);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ counts, candidateGate: { status: candidateGate.status,
    failures: candidateGate.failures, metrics: candidateGate.metrics },
    firstChunkP95AmongQueuedMs: report.firstChunkP95AmongQueuedMs,
    output, releaseGate: report.releaseGate })}\n`);
  if (candidateGate.status !== "pass") process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Speech fallback evaluation could not run; check arguments and configuration.\n");
  process.exitCode = 1;
});
