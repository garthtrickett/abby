import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BoundedCommandError, runBoundedCommand } from "../../scripts/bounded-command.ts";
import { readFile } from "node:fs/promises";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("bounded command preserves failed output and stops a resistant grandchild after timeout",
  { timeout: 15_000 }, async () => {
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e',
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });
      console.log('childPid=' + child.pid);
      console.log('not ok 1 - synthetic early failure');
      for (let i = 0; i < 50; i++) console.log('later output ' + i);
      setInterval(() => {}, 1000);
    `;
    let captured: BoundedCommandError | undefined;
    try { await runBoundedCommand(process.execPath, ["-e", script], 5_000, { cwd: root, env: {} }); }
    catch (error) { assert.ok(error instanceof BoundedCommandError); captured = error; }
    assert.ok(captured, "timed out command must fail");
    assert.match(captured.output, /not ok 1 - synthetic early failure/);
    assert.match(captured.output, /later output 49/);
    const pid = Number(captured.output.match(/childPid=(\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "grandchild must actually start");
    let state = "absent";
    try { state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]!.split(" ")[0]!; }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); }
    assert.ok(state === "absent" || state === "Z", "grandchild must no longer run");
  });

test("bounded command returns successful output and preserves nonzero exit failure",
  { timeout: 15_000 }, async () => {
    assert.equal(await runBoundedCommand(process.execPath, ["-e", "console.log('completed')"],
      5_000, { cwd: root, env: {} }), "completed\n");
    await assert.rejects(runBoundedCommand(process.execPath, ["-e", "console.log('failed'); process.exit(7)"],
      5_000, { cwd: root, env: {} }), error => error instanceof BoundedCommandError &&
      error.output === "failed\n" && error.message.includes("exited 7"));
  });
async function assertStoppedDescendant(pid: number): Promise<void> {
  const until = Date.now() + 1_000;
  let state = "absent";
  while (true) {
    try { state = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]!.split(" ")[0]!; }
    catch (error) {
      // An opened proc file can report ESRCH if the task exits before its read.
      const code = (error as NodeJS.ErrnoException).code;
      assert.ok(code === "ENOENT" || code === "ESRCH", `unexpected proc stat error: ${code}`);
      assert.throws(() => process.kill(pid, 0), error =>
        (error as NodeJS.ErrnoException).code === "ESRCH", "missing proc stat must have no live process");
      return;
    }
    if (state === "Z") return;
    if (Date.now() >= until) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`grandchild must no longer run (state=${state})`);
}

test("bounded command stops inherited-pipe descendants after either successful or failed leader exit",
  { timeout: 15_000 }, async () => {
    for (const code of [0, 7]) {
      const grandchild = 'process.on("SIGTERM", () => {}); process.send("ready"); setTimeout(() => { console.log("natural-exit"); process.exit(0); }, 12000);';
      const script = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],
          { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.once('message', () => { console.log('childPid=' + child.pid); console.log('leader-completed'); process.exit(${code}); });
      `;
      let output = "";
      let captured: BoundedCommandError | undefined;
      try { output = await runBoundedCommand(process.execPath, ["-e", script], 5_000, { cwd: root, env: {} }); }
      catch (error) { assert.ok(error instanceof BoundedCommandError); captured = error; output = error.output; }
      if (code === 0) assert.equal(captured, undefined);
      else { assert.ok(captured); assert.match(captured.message, /exited 7/); }
      assert.match(output, /leader-completed/);
      assert.ok(!output.includes("natural-exit"), "grandchild must be stopped before its natural exit");
      const pid = Number(output.match(/childPid=(\d+)/)?.[1]);
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      await assertStoppedDescendant(pid);
    }
  });

test("bounded command stops a resistant output producer and caps retained output",
  { timeout: 15_000 }, async () => {
    const script = 'process.on("SIGTERM", () => {}); for (let i = 0; i < 40; i++) process.stdout.write("x".repeat(65536)); setTimeout(() => process.exit(0), 12000);';
    let captured: BoundedCommandError | undefined;
    try { await runBoundedCommand(process.execPath, ["-e", script], 5_000, { cwd: root, env: {} }); }
    catch (error) { assert.ok(error instanceof BoundedCommandError); captured = error; }
    assert.ok(captured);
    assert.match(captured.message, /output limit exceeded/);
    assert.ok(captured.output.length <= 2_000_000, "captured output must respect its existing limit");
  });

test("bounded command retains the original exit failure when a separate process group holds output pipes",
  { timeout: 15_000 }, async () => {
    for (const code of [0, 7]) {
      const grandchild = 'process.on("SIGTERM", () => {}); process.send("ready"); setTimeout(() => process.exit(0), 12000);';
      const script = `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],
          { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        child.once('message', () => { console.log('childPid=' + child.pid); console.log('leader-completed'); process.exit(${code}); });
      `;
      let pid: number | undefined;
      let captured: BoundedCommandError | undefined;
      let output = "";
      try {
        try { output = await runBoundedCommand(process.execPath, ["-e", script], 5_000, { cwd: root, env: {} }); }
        catch (error) { assert.ok(error instanceof BoundedCommandError); captured = error; output = error.output; }
        const parsed = Number(output.match(/childPid=(\d+)/)?.[1]);
        assert.ok(Number.isSafeInteger(parsed) && parsed > 0);
        pid = parsed;
        assert.ok(captured);
        assert.match(captured.message, /output streams did not close/);
        assert.match(output, /leader-completed/);
        assert.ok(captured.cause instanceof AggregateError);
        assert.ok(captured.cause.errors.some(error => error instanceof Error &&
          error.message === "command output streams did not close after process cleanup"));
        if (code === 7) assert.ok(captured.cause.errors.some(error => error instanceof Error &&
          error.message === "exited 7"), "output cleanup must retain the original exit failure");
        process.kill(pid, 0); // The helper must not signal a separately owned process group.
      } finally {
        if (pid) {
          try { process.kill(-pid, "SIGKILL"); }
          catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); }
          await assertStoppedDescendant(pid);
        }
      }
    }
  });

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
