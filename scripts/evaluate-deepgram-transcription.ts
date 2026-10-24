import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DeepgramStreamingTranscription } from "../src/voice/deepgram-streaming-transcription.ts";
import { assessSyntheticTranscription } from "../src/voice/transcription-evaluation-gate.ts";
import { parseTranscriptionEvaluationCorpus, runTranscriptionEvaluation } from "../src/voice/transcription-evaluation.ts";
import { deepgramClinicVocabulary } from "./lib/deepgram-clinic-vocabulary.ts";
import { KrispEvaluationTranscription } from "./lib/krisp-evaluation-transcription.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2), args = new Map<string, string>();
  if (argv.length % 2) throw new Error();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1]!;
    if (!["--out", "--corpus", "--profile"].includes(key) || args.has(key) || !value.trim()) throw new Error();
    args.set(key, value);
  }
  const output = args.get("--out"), apiKey = process.env.ABBY_DEEPGRAM_API_KEY;
  const corpusName = args.get("--corpus") ?? "transcription-noise-v1";
  const profile = args.get("--profile") ?? "baseline";
  if (!["baseline", "clinic-v1", "krisp-clinic-v1"].includes(profile)) throw new Error();
  const krispKey = process.env.ABBY_KRISP_API_KEY;
  if (profile === "krisp-clinic-v1" && !krispKey) throw new Error();
  if (!output || !apiKey || !["transcription-noise-v1", "transcription-telephony-v1", "transcription-safety-v1"].includes(corpusName)) throw new Error();
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const corpusBytes = await readFile(resolve(`eval/${corpusName}.json`));
  const corpus = parseTranscriptionEvaluationCorpus(JSON.parse(corpusBytes.toString("utf8")) as unknown);
  const cases = await Promise.all(corpus.cases.map(async item => {
    const pcm = await readFile(resolve("eval/audio", item.file));
    if (digest(pcm) !== item.sha256) throw new Error();
    return { ...item, pcm };
  }));
  const sourcePaths = ["src/voice/deepgram-streaming-transcription.ts", "src/voice/transcription-evaluation.ts",
    "src/voice/transcription-evaluation-gate.ts", "scripts/evaluate-deepgram-transcription.ts",
    "scripts/lib/deepgram-clinic-vocabulary.ts", "scripts/lib/krisp-evaluation-transcription.ts"];
  const before = await Promise.all(sourcePaths.map(path => readFile(resolve(path))));
  const results = await runTranscriptionEvaluation(cases, sessionId => {
    const transcription = new DeepgramStreamingTranscription({ apiKey, sessionId,
      ...(profile === "baseline" ? {} : { keyterms: deepgramClinicVocabulary }) });
    return profile === "krisp-clinic-v1" ? new KrispEvaluationTranscription({
      apiKey: krispKey!, sessionId, transcription }) : transcription;
  }, 3, 2);
  const after = await Promise.all(sourcePaths.map(path => readFile(resolve(path))));
  if (after.some((bytes, i) => !bytes.equals(before[i]!))) throw new Error();
  const counts = { match: 0, mismatch: 0, critical: 0, providerFailure: 0 };
  for (const result of results) counts[result.verdict]++;
  const candidateGate = assessSyntheticTranscription(cases, results);
  const report = { schemaVersion: 1, kind: "realtime-transcription-evaluation", runAt: new Date().toISOString(),
    configuration: { provider: "deepgram-streaming", model: "nova-3", language: "en",
      profile, keyterms: profile === "baseline" ? [] : deepgramClinicVocabulary,
      denoising: profile === "krisp-clinic-v1" ? { provider: "krisp-voice-isolation", model: "VIVA-tel",
        suppressionLevel: 100, inputFrameMs: 30, outputFrameMs: 20, transportPadding: "zero-pad-last-30ms-trim-before-stt",
        sharedFlushDeadlineMs: 2_000, equivalenceToVapi: "notEstablished" } : null,
      turnClosure: "per-turn-close-stream-summary-normal-close", endpointing: false, mipOptOut: true,
      smartFormat: false, numerals: false, corpusVersion: corpus.version, corpusSha256: digest(corpusBytes),
      adapterSha256: digest(Buffer.concat(before)), nodeVersion: process.version, repeats: 3,
      concurrency: 2, audioFormat: corpus.audioFormat }, counts, candidateGate, results,
    humanReviewStatus: "pending", liveCallStatus: "notRun", releaseGate: "unverified" };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ counts, candidateGate, output: resolve(output), releaseGate: "unverified" }) + "\n");
  if (candidateGate.status !== "pass") process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Deepgram synthetic transcription evaluation unavailable; check configuration and fixed fixtures.\n");
  process.exitCode = 1;
});
