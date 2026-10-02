import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
type SchedulingEvent = { kind: "dispatched" | "finished"; file: string; activeFiles: number };

async function execute(options: unknown): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["scripts/ordered-node-e2e.mjs", JSON.stringify(options)],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(45_000) });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, output };
}

test("E2E-251 setting Node files dispatch in observed forward and reverse orders with file lifecycle overlap",
  { timeout: 120_000 }, async () => {
  const files = ["test/voice/automation-toggle-call.test.ts", "test/voice/embedded-booking-setting-call.test.ts"];
  for (const concurrency of [1, 2]) {
    for (const [label, order] of [["forward", files], ["reverse", [...files].reverse()]] as const) {
      const result = await execute({ files: order, concurrency });
      assert.equal(result.code, 0, result.output);
      const events = result.output.split("\n").filter(line => line.startsWith("ABBY_NODE_EVENT "))
        .map(line => JSON.parse(line.slice("ABBY_NODE_EVENT ".length)) as SchedulingEvent);
      assert.deepEqual(events.filter(event => event.kind === "dispatched").map(event => event.file), order);
      assert.equal(events.filter(event => event.kind === "finished").length, files.length);
      assert.equal(Math.max(...events.map(event => event.activeFiles)), concurrency);
      assert.match(result.output, /^# pass 3$/m);
      assert.match(result.output, /^# fail 0$/m);
      assert.match(result.output, /^# skipped 0$/m);
      for (const id of ["E2E-010", "E2E-018", "E2E-074"]) assert.ok(result.output.split("\n")
        .some(line => /^\s*ok \d+ - /.test(line) && line.includes(id)), `${id} did not pass`);
      process.stdout.write(`${label} concurrency=${concurrency}: ${events.filter(event => event.kind === "dispatched")
        .map(event => event.file).join(", ")}\n`);
    }
  }
  for (const options of [{ files: [], concurrency: 1 }, { files: [files[0], files[0]] },
    { files, concurrency: 0 }, { files, unknownOption: true },
    { files: ["test/runner/absent-setting-evidence.test.ts"] }]) {
    const result = await execute(options);
    assert.notEqual(result.code, 0, "invalid scheduling or missing evidence passed");
  }
});
