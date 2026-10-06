import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clinicalIntentPromptVersion } from "../src/standalone/openai-clinical-intent.ts";
import { scanPatientDataCanaries } from "../src/storage/patient-data-canary-scan.ts";
import { resultValue } from "../test/support/agent-appointment-proposals.ts";
import { verificationCanaries } from "../test/support/caller-verification.ts";
import { withDisposablePostgres } from "../test/support/disposable-postgres.ts";
import { candidates, plans } from "./conversation-evaluation/plans.ts";
import { runCase } from "./conversation-evaluation/run-case.ts";
import type { ModelConfig } from "./conversation-evaluation/run-case.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
async function sources(): Promise<{ sha256: string; files: number }> {
  const paths: string[] = ["package.json", "eval/clinic-conversation-candidates-v1.json"];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(resolve(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && child.endsWith(".ts")) paths.push(child);
    }
  }
  for (const path of ["src", "test/support", "scripts"]) await visit(path);
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    const bytes = await readFile(resolve(root, path));
    hash.update(`${path}\0${bytes.length}\0`); hash.update(bytes);
  }
  return { sha256: hash.digest("hex"), files: paths.length };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (![4, 6].includes(args.length) || !["--scripted", "--model"].includes(args[0]!) || args[2] !== "--out" ||
      !args[1]?.trim() || !args[3]?.trim() || (args.length === 6 && args[4] !== "--case"))
    throw new Error("usage: --scripted baseline|--model MODEL --out REPORT [--case CCP-ID]");
  const mode = args[0] === "--model" ? "live" : "scripted";
  if (mode === "scripted" && args[1] !== "baseline") throw new Error("unknown scripted profile");
  const model: ModelConfig = { mode, model: mode === "live" ? args[1]! : "scripted-unsupported-baseline",
    apiKey: mode === "live" ? process.env.ABBY_OPENAI_API_KEY ?? "" : "synthetic-conversation-key" };
  if (!model.apiKey) throw new Error("missing owner-only model key");
  const corpus = await candidates(), selected = args[5] ? corpus.filter(item => item.id === args[5]) : corpus;
  if (!selected.length) throw new Error("unknown case");
  const output = resolve(args[3]!), journal = `${output}.jsonl`;
  await mkdir(dirname(output), { recursive: true });
  // Reserve both files before spending money. Existing baselines cannot be replaced.
  await writeFile(output, "", { mode: 0o600, flag: "wx" });
  await writeFile(journal, "", { mode: 0o600, flag: "wx" });
  const source = await sources(), start = new Date().toISOString();
  type Completed = Awaited<ReturnType<typeof runCase>>;
  type Failed = { id: string; status: "harnessFailure"; failureClass: string };
  const results: (Completed | Failed)[] = [];
  let next = 0, privacyPass = false;
  await withDisposablePostgres(async db => {
    // Every call owns its own provider/mail/approval files, scope, owner and wire.
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (next < selected.length) {
        const item = selected[next++]!;
        let result: Completed | Failed;
        try { result = await runCase(db, item, plans[item.id]!, model); }
        catch (error) { result = { id: item.id, status: "harnessFailure", failureClass: error instanceof Error ? error.name : "unknown" }; }
        results.push(result);
        await appendFile(journal, `${JSON.stringify(result)}\n`);
        process.stdout.write(`${item.id} ${result.status}${result.status === "executed" ? ` observations=${result.checks.filter(check => check.pass).length}/${result.checks.length} setup=${result.setupMatch ? "matched" : "gap"}` : ""}\n`);
      }
    }));
    privacyPass = resultValue(await scanPatientDataCanaries(db, verificationCanaries.map((value, index) => ({ label: `conversation_${index}`, value })))).length === 0;
  });
  const finalSource = await sources();
  const sourceStable = finalSource.sha256 === source.sha256;
  const counts = { corpus: corpus.length, selected: selected.length, executed: results.filter(item => item.status === "executed").length,
    harnessFailures: results.filter(item => item.status === "harnessFailure").length,
    setupGaps: results.filter(item => item.status === "executed" && !item.setupMatch).length,
    failedObservations: results.reduce((sum, item) => sum + (item.status === "executed" ? item.checks.filter(check => !check.pass).length : 0), 0) };
  const report = { version: 1, kind: "synthetic-clinic-conversation-baseline", startedAt: start, finishedAt: new Date().toISOString(),
    model: model.model, mode, promptVersion: clinicalIntentPromptVersion, source, corpusVersion: "clinic-conversation-candidates-v1",
    setupInterpretation: "Pinned structured responses establish actual workflow states; they are not language understanding evidence.",
    candidateInterpretation: mode === "live" ? "Only candidate turns may make live model requests under the production five-second deadline; trusted menu matching and exact affirmation bypass the model. Request counts distinguish these paths."
      : "Candidate responses are deliberately scripted unsupported. This measures harness/safety behavior, not model interpretation.",
    gate: "partial-baseline-not-a-release-gate", audio: "Synthetic clear-final transcription and synthesis; no real caller audio or Twilio number.",
    counts, privacyPass, sourceStable, results: results.sort((a, b) => a.id.localeCompare(b.id)) };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...counts, privacyPass, output, gate: report.gate })}\n`);
  if (counts.harnessFailures || counts.failedObservations || !privacyPass || !sourceStable) process.exitCode = 1;
}

main().catch(() => { process.stderr.write("Conversation baseline failed; existing reports are preserved and no credentials are printed.\n"); process.exitCode = 1; });
