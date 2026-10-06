import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { clinicalIntentPromptVersion, createOpenAIClinicalIntentResolver } from "../src/standalone/openai-clinical-intent.ts";
import { bookingCallFlowFixture, cancellationCallFlowFixture, reschedulingCallFlowFixture, intakeCallFlowFixture } from "../test/support/cliniko-call-flow.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--model" || args[2] !== "--out" || !args[1]?.trim() || !args[3]?.trim())
    throw new Error("usage: --model MODEL --out REPORT");
  const key = process.env.ABBY_OPENAI_API_KEY;
  if (!key) throw new Error("missing model key");
  const cases = [
    { name: "book", text: "I need to book an appointment.", expected: { kind: "workflow", operation: "book" }, fixture: bookingCallFlowFixture },
    { name: "cancel", text: "I need to cancel an appointment.", expected: { kind: "workflow", operation: "cancel" }, fixture: cancellationCallFlowFixture },
    { name: "reschedule", text: "I need to move an appointment.", expected: { kind: "workflow", operation: "reschedule" }, fixture: reschedulingCallFlowFixture },
    { name: "new-patient", text: "I'm new to this clinic and want to register.", expected: { kind: "workflow", operation: "intake" }, fixture: intakeCallFlowFixture },
    { name: "identity-disagreement-paraphrase", text: "You have linked this conversation to somebody different from its speaker.",
      expected: { kind: "callerIdentityDenied", reason: "identityDisagreement" }, fixture: bookingCallFlowFixture },
    { name: "shared-phone-paraphrase", text: "My partner and I both use the number I am ringing from.",
      expected: { kind: "callerIdentityDenied", reason: "sharedPhone" }, fixture: bookingCallFlowFixture },
    { name: "shared-line-model-paraphrase", text: "More than one person uses the line I am calling you on.",
      expected: { kind: "callerIdentityDenied", reason: "sharedPhone" }, fixture: bookingCallFlowFixture },
    { name: "outcome", text: "Did that action work?", expected: { kind: "outcome" }, fixture: bookingCallFlowFixture },
  ] as const;
  const results = await Promise.all(cases.map(async item => {
    const f = await item.fixture();
    try {
      let requests = 0;
      const resolveIntent = createOpenAIClinicalIntentResolver({ owner: f.flow, apiKey: key, model: args[1]!,
        clinicDate: () => "2026-10-04", fetch: async (...args) => { requests++; return fetch(...args); } });
      const result = await resolveIntent(f.turn(`live-${item.name}`, item.text));
      const actual = result.ok ? result.value : { kind: "intentUnavailable" };
      return { name: item.name, requests, pass: JSON.stringify(actual) === JSON.stringify(item.expected), expected: item.expected, actual };
    } finally { f.flow.dispose(); await f.close(); }
  }));
  const adapter = await Promise.all(["src/standalone/openai-clinical-intent.ts", "src/standalone/cliniko-call-flow.ts", "src/standalone/caller-identity-language.ts", "src/standalone/appointment-change-language.ts"]
    .map(path => readFile(resolve(path))));
  const hash = createHash("sha256"); for (const source of adapter) hash.update(source);
  const report = { version: 1, kind: "clinical-intent-live-evaluation", at: new Date().toISOString(), model: args[1],
    promptVersion: clinicalIntentPromptVersion, adapterSha256: hash.digest("hex"),
    gate: "classification-sample-only", pass: results.filter(item => item.pass).length, total: results.length, results };
  await mkdir(dirname(resolve(args[3]!)), { recursive: true });
  await writeFile(resolve(args[3]!), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ pass: report.pass, total: report.total, gate: report.gate, output: resolve(args[3]!) })}\n`);
  if (report.pass !== report.total) process.exitCode = 1;
}

main().catch(() => {
  process.stderr.write("Clinical intent evaluation failed; inspect the owner-only report or provider configuration.\n");
  process.exitCode = 1;
});
