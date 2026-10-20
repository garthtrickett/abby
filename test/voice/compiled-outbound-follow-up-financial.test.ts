// E2E-421: the actual outgoing caller feeds the independent financial lifecycle.
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const outcome of ["paid", "closedUnpaid"] as const)
test(`compiled original outgoing follow-up booking retains its independent financial lifecycle: ${outcome}`,
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 600_000 }, async () => {
    const folder = await mkdtemp(join(tmpdir(), "abby-outgoing-financial-chain-"));
    const child = fork(new URL("../../dist/runtime/test/support/outbound-follow-up-financial-process.js", import.meta.url), [], {
      cwd: folder, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
        NODE_OPTIONS: "--max-old-space-size=256", DATABASE_URL: "intentionally-not-a-database-url" } });
    const terminal = once(child, "exit"), output: string[] = [], stages: number[] = [];
    child.stdout?.on("data", data => output.push(String(data))); child.stderr?.on("data", data => output.push(String(data)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let location = { file: 0, line: 0 };
    const result = new Promise<boolean>((resolve, reject) => {
      child.once("error", reject); child.once("exit", () => reject(Error("compiled outgoing chain exited before result")));
      child.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) { reject(Error("invalid outgoing chain result")); return; }
        const value = raw as { kind?: unknown; stage?: unknown; passed?: unknown; file?: unknown; line?: unknown };
        if (Object.keys(raw).sort().join(",") === "kind,stage" && value.kind === "stage" && Number.isInteger(value.stage) && Number(value.stage) >= 1 && Number(value.stage) <= 7) {
          stages.push(Number(value.stage)); return;
        }
        if (Object.keys(raw).sort().join(",") !== "file,kind,line,passed" || value.kind !== "result" || typeof value.passed !== "boolean" ||
            !Number.isInteger(value.file) || Number(value.file) < 0 || Number(value.file) > 6 || !Number.isInteger(value.line) || Number(value.line) < 0 || Number(value.line) > 4096) {
          reject(Error("invalid outgoing chain result")); return;
        }
        location = { file: Number(value.file), line: Number(value.line) }; resolve(value.passed);
      });
      timer = setTimeout(() => reject(Error(`compiled outgoing financial deadline after stage${stages.at(-1) ?? 0}`)), 570_000);
    });
    child.send({ kind: "start", outcome });
    try {
      assert.equal(await result, true, `outgoing financial chain failed after stage${stages.at(-1) ?? 0}; fixed location ${JSON.stringify(location)}`);
      assert.deepEqual(await terminal, [0, null]); assert.deepEqual(stages, [1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual(output, []); assert.deepEqual(await readdir(folder), []);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await terminal; }
      await rm(folder, { recursive: true, force: true });
    }
  });
