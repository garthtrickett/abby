import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseTranscriptionEvaluationCorpus } from "../src/voice/transcription-evaluation.ts";

type Model = "gpt-transcribe" | "gpt-4o-transcribe";
type Verdict = "match" | "mismatch" | "critical" | "providerFailure";
type Context = "none" | "clinic-v1";

const clinicContext = { prompt: "English physiotherapy clinic calls about appointments, booking, and urgent symptoms.",
  keywords: ["physiotherapy", "appointment", "booking", "urgent"], languages: ["en"] } as const;

function argsFrom(argv: readonly string[]): Record<string, string> {
  const allowed = new Set(["out", "corpus", "model", "context", "repeats", "concurrency"]);
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

function wavFromPcm(pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  wav.set(pcm, 44);
  return Uint8Array.from(wav);
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function classify(actual: string, expected: string, criticalTerms: readonly string[]): Verdict {
  const actualWords = words(actual);
  const expectedWords = words(expected);
  if (actualWords.join(" ") === expectedWords.join(" ")) return "match";
  return criticalTerms.some(term => !actualWords.includes(term.toLowerCase())) ? "critical" : "mismatch";
}

async function transcribe(apiKey: string, model: Model, context: Context,
  wav: Uint8Array<ArrayBuffer>): Promise<string> {
  const form = new FormData();
  form.set("model", model);
  form.set("file", new Blob([wav], { type: "audio/wav" }), "synthetic.wav");
  if (context === "clinic-v1") {
    form.set("prompt", clinicContext.prompt);
    for (const keyword of clinicContext.keywords) form.append("keywords[]", keyword);
    for (const language of clinicContext.languages) form.append("languages[]", language);
  }
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("transcription provider failure");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("text" in result) ||
      typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("invalid transcription response");
  }
  return result.text;
}

async function main(): Promise<void> {
  const args = argsFrom(process.argv.slice(2));
  const apiKey = process.env.ABBY_OPENAI_API_KEY;
  if (!apiKey) throw new Error("ABBY_OPENAI_API_KEY is required");
  const corpusName = args.corpus ?? "transcription-noise-v1";
  if (!["transcription-v1", "transcription-telephony-v1", "transcription-noise-v1",
    "transcription-safety-v1"].includes(corpusName)) {
    throw new Error("unsupported transcription evaluation corpus");
  }
  const model = args.model ?? "gpt-transcribe";
  if (model !== "gpt-transcribe" && model !== "gpt-4o-transcribe") throw new Error("unsupported model");
  const context = args.context ?? "none";
  if ((context !== "none" && context !== "clinic-v1") ||
      (context === "clinic-v1" && model !== "gpt-transcribe")) throw new Error("unsupported context");
  const repeats = args.repeats === undefined ? 2 : Number(args.repeats);
  const concurrency = args.concurrency === undefined ? 2 : Number(args.concurrency);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10 ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("invalid evaluation run size");
  }

  const corpusBytes = await readFile(resolve(`eval/${corpusName}.json`));
  const corpus = parseTranscriptionEvaluationCorpus(JSON.parse(corpusBytes.toString("utf8")) as unknown);
  const cases = await Promise.all(corpus.cases.map(async item => {
    const pcm = await readFile(resolve("eval/audio", item.file));
    if (digest(pcm) !== item.sha256 || pcm.length < 640 || pcm.length > 1_000_000 || pcm.length % 2) {
      throw new Error("transcription fixture changed or invalid");
    }
    return { item, wav: wavFromPcm(pcm) };
  }));
  const jobs = cases.flatMap(value => Array.from({ length: repeats }, (_, index) => ({ ...value, repeat: index + 1 })));
  const results = new Array<{ caseId: string; category: string; repeat: number; verdict: Verdict;
    actualText: string; totalMs: number; quality: "needsClarification" | "unavailable" }>(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (;;) {
      const index = next++;
      const job = jobs[index];
      if (!job) return;
      const started = performance.now();
      let actualText = "";
      let verdict: Verdict = "providerFailure";
      try {
        actualText = await transcribe(apiKey, model, context, job.wav);
        verdict = classify(actualText, job.item.expectedText, job.item.criticalTerms);
      } catch { /* Keep provider failures separate from wrong words. */ }
      results[index] = { caseId: job.item.id, category: job.item.category, repeat: job.repeat,
        verdict, actualText, totalMs: Math.round(performance.now() - started),
        quality: verdict === "providerFailure" ? "unavailable" : "needsClarification" };
    }
  }));

  const counts: Record<Verdict, number> = { match: 0, mismatch: 0, critical: 0, providerFailure: 0 };
  for (const result of results) counts[result.verdict] += 1;
  const report = { schemaVersion: 1, kind: "file-transcription-evaluation", runAt: new Date().toISOString(),
    configuration: { provider: "openai-audio-transcriptions", model, contextVersion: context,
      contextSha256: digest(Buffer.from(context === "clinic-v1" ? JSON.stringify(clinicContext) : "none")),
      corpusVersion: corpus.version,
      corpusSha256: digest(corpusBytes), runnerSha256: digest(await readFile(resolve("scripts/evaluate-file-transcription.ts"))),
      nodeVersion: process.version, repeats, concurrency, audioFormat: "mono-wav-pcm16le-16000" },
    counts, results, humanReviewStatus: "pending", liveCallStatus: "notRun", releaseGate: "unverified" };
  const output = resolve(args.out!);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ counts, output, releaseGate: report.releaseGate })}\n`);
  if (counts.critical || counts.mismatch || counts.providerFailure) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("File transcription evaluation could not run; check arguments, configuration, and fixtures.\n");
  process.exitCode = 1;
});
