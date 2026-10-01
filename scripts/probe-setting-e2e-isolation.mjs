import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../phase-0/SCENARIO_MANIFEST.json", import.meta.url), "utf8"));
const cases = [
  { id: "E2E-004", file: "test/voice/embedded-knowledge-approval-call.test.ts" },
  { id: "E2E-004", file: "test/composition/embedded-knowledge-signed-voice.test.ts" },
  { id: "E2E-010", file: "test/voice/embedded-booking-setting-call.test.ts" },
  { id: "E2E-074", file: "test/voice/embedded-booking-setting-call.test.ts" },
  { id: "E2E-018", file: "test/voice/automation-toggle-call.test.ts" },
  { id: "E2E-074", file: "test/voice/voice.test.ts" },
  { id: "E2E-226", file: "test/voice/embedded-cliniko-booking-host-call.test.ts" },
];

for (const { id, file } of cases) {
  const scenario = manifest.scenarios.find(row => row.id === id);
  assert.ok(scenario?.syntheticVoiceEvidence?.testFiles.includes(file), `${id} must map to ${file}`);
}

async function run(files, pattern, concurrency) {
  const args = ["--test", `--test-concurrency=${concurrency}`, `--test-name-pattern=${pattern}`, ...files];
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(120_000) });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const count = name => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? -1);
  const result = { pass: count("pass"), fail: count("fail"), skipped: count("skipped") };
  if (exitCode !== 0 || result.pass < 1 || result.fail !== 0) {
    throw new Error(`node ${args.join(" ")} exited ${exitCode}:\n${output.split("\n").slice(-55).join("\n")}`);
  }
  return result;
}

let isolatedPasses = 0;
for (const { id, file } of cases) {
  const result = await run([file], id, 1);
  isolatedPasses += result.pass;
  process.stdout.write(`alone ${id} ${file}: ${result.pass} passed, ${result.fail} failed\n`);
}

const files = [...new Set(cases.map(item => item.file))];
const pattern = [...new Set(cases.map(item => item.id))].join("|");
for (const [label, order] of [["forward", files], ["reverse", [...files].reverse()]]) {
  const result = await run(order, pattern, 4);
  assert.equal(result.pass, isolatedPasses, `${label} parallel run lost or gained a passing case`);
  process.stdout.write(`parallel ${label}: ${result.pass} passed, ${result.fail} failed across ${order.length} files\n`);
}
