import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(process.env.ABBY_ISOLATED_POSTGRES_PROBE, "1", "isolated PostgreSQL is required");
assert.ok(process.env.DATABASE_URL, "isolated PostgreSQL connection is required");
const manifest = JSON.parse(await readFile(new URL("../phase-0/SCENARIO_MANIFEST.json", import.meta.url), "utf8"));
const scenarios = new Map(manifest.scenarios.map(row => [row.id, row]));
const nodeFiles = new Map();
const browserFiles = new Map();

for (const [setting, ids] of Object.entries(manifest.settingMappings)) {
  let mapped = 0;
  for (const id of ids) {
    const scenario = scenarios.get(id);
    assert.ok(scenario, `${setting} refers to missing ${id}`);
    for (const evidence of [scenario.textEvidence, scenario.syntheticVoiceEvidence, scenario.fullCallEvidence]) {
      if (evidence?.status !== "passed") continue;
      for (const file of evidence.testFiles) {
        const target = file.endsWith(".spec.ts") ? browserFiles : nodeFiles;
        assert.match(file, /^test\/[a-z-]+\/[a-z0-9-]+\.(?:test|spec)\.ts$/);
        if (!target.has(file)) target.set(file, new Set());
        target.get(file).add(id);
        mapped += 1;
      }
    }
  }
  assert.ok(mapped > 0, `${setting} has no runnable evidence`);
}
assert.ok(nodeFiles.size > 0 && browserFiles.size > 0);

async function execute(command, args, timeoutMs, env = process.env) {
  const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(timeoutMs), env });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    output += chunk.toString();
    if (output.length > 2_000_000) child.kill();
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0) {
    const lines = output.split("\n");
    const first = lines.findIndex(line => /^\s*not ok \d+ - /.test(line));
    const excerpt = first >= 0 ? lines.slice(Math.max(0, first - 3), first + 18) : lines.slice(-35);
    throw new Error(`${command} ${args.join(" ")} exited ${code}:\n${excerpt.join("\n")}\n${lines.slice(-10).join("\n")}`);
  }
  return output;
}

function idsFor(entries) { return [...new Set(entries.flatMap(([, ids]) => [...ids]))]; }
async function withFreshDatabase(run) {
  const name = `abby_setting_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
    const env = { ...process.env, DATABASE_URL: url.toString() };
    await execute(process.execPath, ["scripts/migrate.ts"], 120_000, env);
    return await run(env);
  } finally {
    try { await admin.query(`drop database if exists "${name}" with (force)`); }
    finally { await admin.end(); }
  }
}
function checkedNode(output, ids) {
  const count = name => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "m"))?.[1] ?? -1);
  assert.equal(count("fail"), 0);
  assert.equal(count("cancelled"), 0);
  assert.equal(count("skipped"), 0, "an evidence file skipped a test");
  // A composed journey can cover more than one mapped ID; every ID still needs a passing test line below.
  assert.ok(count("pass") >= 1, "selected Node cases did not pass");
  for (const id of ids) {
    assert.ok(output.split("\n").some(line => /^\s*ok \d+ - /.test(line) &&
      line.includes(id) && !line.includes("# SKIP")), `${id} did not execute`);
  }
  return count("pass");
}
async function runNode(entries, concurrency) {
  const ids = idsFor(entries);
  // Run whole files: Node's name filter can skip a nested E2E when its parent suite has no ID.
  const output = await withFreshDatabase(env => execute(process.execPath, ["--test", `--test-concurrency=${concurrency}`,
    ...entries.map(([file]) => file)], 600_000, env));
  return checkedNode(output, ids);
}

function checkedBrowser(output, ids) {
  const passed = Number(output.match(/\b(\d+) passed \(/)?.[1] ?? -1);
  assert.ok(passed >= ids.length, "selected browser cases did not pass");
  assert.doesNotMatch(output, /\b\d+ (?:failed|skipped)\b/);
  for (const id of ids) assert.ok(output.includes(id), `${id} browser case did not execute`);
  return passed;
}
async function runBrowser(entries, workers) {
  const ids = idsFor(entries);
  const output = await execute("node_modules/.bin/playwright", ["test", ...entries.map(([file]) => file),
    "--grep", ids.join("|"), `--workers=${workers}`], 240_000);
  return checkedBrowser(output, ids);
}

await execute("npm", ["run", "build:cliniko-admin"], 120_000);
const nodeEntries = [...nodeFiles.entries()].sort(([left], [right]) => left.localeCompare(right));
let nodeTotal = 0;
for (const entry of nodeEntries) {
  const passed = await runNode([entry], 1);
  nodeTotal += passed;
  process.stdout.write(`alone Node ${entry[0]}: ${passed} passed\n`);
}
for (const [order, entries] of [["forward", nodeEntries], ["reverse", [...nodeEntries].reverse()]]) {
  const passed = await runNode(entries, 4);
  assert.equal(passed, nodeTotal, `${order} Node run lost or gained a case`);
  process.stdout.write(`parallel Node ${order}: ${passed} passed across ${entries.length} files\n`);
}

await execute("npm", ["run", "build:dashboard"], 120_000);
const browserEntries = [...browserFiles.entries()].sort(([left], [right]) => left.localeCompare(right));
let browserTotal = 0;
for (const entry of browserEntries) {
  const passed = await runBrowser([entry], 1);
  browserTotal += passed;
  process.stdout.write(`alone browser ${entry[0]}: ${passed} passed\n`);
}
for (const [order, entries] of [["forward", browserEntries], ["reverse", [...browserEntries].reverse()]]) {
  const passed = await runBrowser(entries, 3);
  assert.equal(passed, browserTotal, `${order} browser run lost or gained a case`);
  process.stdout.write(`parallel browser ${order}: ${passed} passed across ${entries.length} files\n`);
}
