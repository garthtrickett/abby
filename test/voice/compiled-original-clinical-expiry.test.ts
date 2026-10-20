import { financialExpiryProbeResult } from "../support/financial-expiry-observation.ts";
import type { FinancialExpiryObservation } from "../support/financial-expiry-observation.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const enabled = process.env.ABBY_ISOLATED_POSTGRES_PROBE === "1";
for (const scenario of ["individual", "ordinaryClass", "passClass", "reviewTerms"] as const) test(`compiled original caller conditional clinical expiry (${scenario})`, { skip: !enabled, timeout: 600_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "abby-financial-chain-compiled-"));
  const child = fork(new URL("../../dist/runtime/test/support/financial-original-clinical-expiry-process.js", import.meta.url), [], {
    cwd: folder, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env,
      NODE_OPTIONS: "--max-old-space-size=256", DATABASE_URL: "intentionally-not-a-database-url" } });
  const terminal = once(child, "exit"), output: string[] = [], stages: number[] = [];
  child.stdout?.on("data", d => output.push(String(d))); child.stderr?.on("data", d => output.push(String(d)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let location = { file: 0, line: 0 };
  let observation: FinancialExpiryObservation | undefined;
  const result = new Promise<boolean>((resolve, reject) => {
    child.once("error", reject); child.once("exit", () => reject(new Error("compiled caller chain exited before result")));
    child.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { reject(new Error("invalid caller chain result")); return; }
      const value = raw as { kind?: unknown; passed?: unknown; stage?: unknown; file?: unknown; line?: unknown };
      if (Object.keys(raw).sort().join(",") === "kind,stage" && value.kind === "stage" && Number.isInteger(value.stage) && Number(value.stage) >= 1 && Number(value.stage) <= 7) {
        stages.push(Number(value.stage)); return;
      }
      const found = financialExpiryProbeResult(raw);
      if (!found) { reject(new Error("invalid caller chain result")); return; }
      location = { file: found.file, line: found.line }; observation = found.observation; resolve(found.passed);
    });
    // Whole caller-plus-finance journey only. The caller retains its own120s.
    timer = setTimeout(() => reject(new Error(`compiled caller chain deadline after stage${stages.at(-1) ?? 0}`)), 570_000);
  });
  child.send({ kind: "start", scenario });
  try {
    assert.equal(await result, true, `compiled caller expiry failed after stage${stages.at(-1) ?? 0}; fixed location ${JSON.stringify(location)}; bounded expiry ${JSON.stringify(observation ?? null)}`);
    assert.deepEqual(await terminal, [0, null]); assert.deepEqual(stages, [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(output, []); assert.deepEqual(await readdir(folder), []);
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await terminal; }
    await rm(folder, { recursive: true, force: true });
  }
});
