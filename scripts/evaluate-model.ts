import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEvaluationCorpus, runModelEvaluation } from "../src/model/evaluation.ts";
import { OpenAIResponsesPort } from "../src/model/openai-responses-port.ts";
import { ModelIngress } from "../src/model/proposal.ts";

function argumentsFrom(argv: readonly string[]): Record<string, string> {
  const allowed = new Set(["model", "prompt-version", "prompt", "corpus", "out", "repeats", "concurrency"]);
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!key || !argv[i]?.startsWith("--") || !allowed.has(key) || !value || values[key] !== undefined)
      throw new Error("invalid evaluation arguments");
    values[key] = value;
  }
  for (const required of ["model", "prompt-version", "out"]) if (!values[required]?.trim())
    throw new Error(`missing --${required}`);
  return values;
}

function hash(parts: readonly (string | Uint8Array)[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest("hex");
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const apiKey = process.env.ABBY_OPENAI_API_KEY;
  if (!apiKey) throw new Error("ABBY_OPENAI_API_KEY is required for a live model evaluation");
  const corpusPath = resolve(args.corpus ?? "eval/model-v1.json");
  const promptPath = resolve(args.prompt ?? `eval/${args["prompt-version"]}.txt`);
  const corpusBytes = await readFile(corpusPath);
  const promptBytes = await readFile(promptPath);
  const corpus = parseEvaluationCorpus(JSON.parse(corpusBytes.toString("utf8")) as unknown);
  const prompt = promptBytes.toString("utf8").trim();
  if (!prompt || prompt.length > 10_000) throw new Error("invalid evaluation prompt");
  const adapterPaths = ["src/model/openai-responses-port.ts", "src/model/proposal.ts", "src/model/evaluation.ts", "scripts/evaluate-model.ts"];
  const adapterBytes = await Promise.all(adapterPaths.map(path => readFile(resolve(path))));
  const ingress = new ModelIngress(new OpenAIResponsesPort({ apiKey, model: args.model!,
    promptVersion: args["prompt-version"]!, instructions: prompt }));
  const repeats = args.repeats === undefined ? 3 : Number(args.repeats);
  const concurrency = args.concurrency === undefined ? 4 : Number(args.concurrency);
  const results = await runModelEvaluation(corpus, ingress, args["prompt-version"]!, repeats, concurrency);
  const counts = { match: 0, mismatch: 0, critical: 0, providerFailure: 0 };
  for (const result of results) counts[result.verdict] += 1;
  const report = {
    schemaVersion: 1,
    kind: "model-only-evaluation",
    runAt: new Date().toISOString(),
    configuration: { provider: "openai-responses", model: args.model, promptVersion: args["prompt-version"],
      promptSha256: hash([promptBytes]), corpusVersion: corpus.version, corpusSha256: hash([corpusBytes]),
      adapterSha256: hash(adapterBytes), nodeVersion: process.version, repeats, concurrency },
    counts,
    results,
    humanReviewStatus: "pending",
    voiceEvaluationStatus: "notRun",
    releaseGate: "unverified",
  };
  await mkdir(dirname(resolve(args.out!)), { recursive: true });
  await writeFile(resolve(args.out!), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ counts, output: resolve(args.out!), releaseGate: report.releaseGate })}\n`);
  if (counts.critical || counts.mismatch || counts.providerFailure) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Model evaluation could not run; check arguments, configuration, and output path.\n");
  process.exitCode = 1;
});
