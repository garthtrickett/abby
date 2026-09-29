import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseAvailabilityEvaluationCorpus, runAvailabilityIntentEvaluation } from "../src/standalone/availability-intent-evaluation.ts";
import { availabilityIntentPromptVersion, createOpenAIAvailabilityIntentResolver } from "../src/standalone/openai-availability-intent.ts";

function argumentsFrom(argv: readonly string[]): Record<string, string> {
  const allowed = new Set(["model", "corpus", "out", "repeats", "concurrency"]);
  const values: Record<string, string> = {};
  if (argv.length % 2 !== 0) throw new Error("invalid evaluation arguments");
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const key = argument?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || !key || !allowed.has(key) || !value || values[key] !== undefined) {
      throw new Error("invalid evaluation arguments");
    }
    values[key] = value;
  }
  for (const required of ["model", "out"]) if (!values[required]?.trim()) throw new Error(`missing --${required}`);
  return values;
}

function sha256(parts: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const apiKey = process.env.ABBY_OPENAI_API_KEY;
  if (!apiKey) throw new Error("ABBY_OPENAI_API_KEY is required");
  const corpusPath = resolve(args.corpus ?? "eval/availability-intent-v1.json");
  const corpusBytes = await readFile(corpusPath);
  const corpus = parseAvailabilityEvaluationCorpus(JSON.parse(corpusBytes.toString("utf8")) as unknown);
  const adapterPaths = ["src/standalone/openai-availability-intent.ts",
    "src/standalone/availability-intent-evaluation.ts", "scripts/evaluate-availability-intent.ts"];
  const adapterBytes = await Promise.all(adapterPaths.map(path => readFile(resolve(path))));
  const resolveIntent = createOpenAIAvailabilityIntentResolver({ apiKey, model: args.model!,
    clinicDate: () => corpus.clinicDate });
  const repeats = args.repeats === undefined ? 3 : Number(args.repeats);
  const concurrency = args.concurrency === undefined ? 4 : Number(args.concurrency);
  const results = await runAvailabilityIntentEvaluation(corpus, resolveIntent, repeats, concurrency);
  const counts = { match: 0, mismatch: 0, critical: 0, providerFailure: 0 };
  for (const result of results) counts[result.verdict] += 1;
  const report = { schemaVersion: 1, kind: "availability-intent-evaluation", runAt: new Date().toISOString(),
    configuration: { provider: "openai-responses", model: args.model,
      promptVersion: availabilityIntentPromptVersion, corpusVersion: corpus.version,
      corpusSha256: sha256([corpusBytes]), adapterSha256: sha256(adapterBytes),
      nodeVersion: process.version, repeats, concurrency },
    counts, results, humanReviewStatus: "pending", voiceEvaluationStatus: "notRun", releaseGate: "unverified" };
  const output = resolve(args.out!);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ counts, output, releaseGate: report.releaseGate })}\n`);
  if (counts.critical || counts.mismatch || counts.providerFailure) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Availability intent evaluation could not run; check arguments, configuration, and output path.\n");
  process.exitCode = 1;
});
