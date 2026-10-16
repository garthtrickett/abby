import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { OpenAIRealtimeSpeechSynthesis } from "../src/voice/openai-realtime-speech-synthesis.ts";
import { buildBookingSpeechPairs, bookingCorpus, pcm16Wav } from "./lib/booking-speech-fixtures.ts";
import type { TranscriptionEvaluationCorpus } from "../src/voice/transcription-evaluation.ts";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== "--out-dir" || !process.argv[3]?.trim() || !process.env.ABBY_OPENAI_API_KEY) throw new Error("invalid configuration");
  const directory = resolve(process.argv[3]); await mkdir(directory, { mode: 0o700 });
  const sources = await Promise.all(["scripts/build-booking-transcription-fixtures.ts", "scripts/lib/booking-speech-fixtures.ts", "src/voice/openai-realtime-speech-synthesis.ts", "src/voice/transport-media-normalizer.ts"].map(async path => ({ path, sha256: sha(await readFile(resolve(path))) })));
  const cases: TranscriptionEvaluationCorpus["cases"][number][] = [], pairs: unknown[] = [];
  const report = { schema: "abby.synthetic-booking-fixtures.v1", state: "running", startedAt: new Date().toISOString(), patientFree: true, synthesis: { model: "gpt-realtime-2.1-mini", voices: ["coral", "cedar"], providerTranscriptCheck: "productionAdapterLiteralMatch", acousticMatch: "unverified" }, sourceFiles: sources,
    ffmpeg: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0], noise: { kind: "seededWhite", nominalSnrDb: 10, stage: "beforePcmuEncoding" }, pairs, humanReview: "notRun", carrier: "notRun", releaseGate: "unverified" };
  const reportPath = join(directory, "generation.json"); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  for await (const pair of buildBookingSpeechPairs(voice => new OpenAIRealtimeSpeechSynthesis({ apiKey: process.env.ABBY_OPENAI_API_KEY!, voice }), AbortSignal.timeout(240_000))) {
    await writeFile(join(directory, pair.sourceName), pair.source, { flag: "wx", mode: 0o600 });
    for (const item of pair.fixtures) { await writeFile(join(directory, item.file), item.pcm, { flag: "wx", mode: 0o600 }); await writeFile(join(directory, item.file.replace(/\.pcm$/, ".wav")), pcm16Wav(item.pcm), { flag: "wx", mode: 0o600 });
      cases.push({ id: item.id, category: item.category, file: item.file, sha256: sha(item.pcm), expectedText: item.expectedText, criticalTerms: [...item.criticalTerms] }); }
    pairs.push({ source: pair.sourceName, sourceSha256: sha(pair.source), sourceBytes: pair.source.length, text: pair.text, voice: pair.voice, measuredPreCodecSnrDb: pair.measuredSnrDb, clippedSamples: pair.clippedSamples, files: pair.fixtures.map(f => f.file) });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); console.log(JSON.stringify({ voice: pair.voice, source: pair.sourceName, fixtures: cases.length }));
  }
  const corpus = Buffer.from(JSON.stringify(bookingCorpus(cases), null, 2) + "\n"); await writeFile(join(directory, "transcription-booking-v1.json"), corpus, { flag: "wx", mode: 0o600 });
  report.state = "completed"; await writeFile(reportPath, JSON.stringify({ ...report, finishedAt: new Date().toISOString(), corpusSha256: sha(corpus) }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ fixtures: cases.length, directory, releaseGate: "unverified" }));
}
main().catch(() => { console.error("Booking speech fixtures could not be completed; inspect the owner-only partial generation report."); process.exitCode = 1; });
