import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const enabled = process.env.ABBY_ISOLATED_POSTGRES_PROBE === "1";
for (const passes of [false, true]) test(`compiled real clinical host owns class financial played consent and privacy (pass=${passes})`, { skip: !enabled, timeout: 150_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), "abby-financial-host-compiled-"));
  const child = fork(new URL("../../dist/runtime/test/support/financial-class-voice-process.js", import.meta.url), [], {
    cwd: folder, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" } });
  const output: string[] = []; child.stdout?.on("data", d => output.push(String(d))); child.stderr?.on("data", d => output.push(String(d)));
  const terminal = once(child, "exit"); let timer: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<boolean>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("compiled financial journey exited before result")));
    child.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "kind,passed") {
        reject(new Error("invalid fixed financial journey result")); return;
      }
      const value = raw as { kind: unknown; passed: unknown };
      if (value.kind !== "result" || typeof value.passed !== "boolean") { reject(new Error("invalid fixed financial journey result")); return; }
      resolve(value.passed);
    });
    // Same120s journey budget as the source test; parent allows teardown only.
    timer = setTimeout(() => reject(new Error("compiled financial journey deadline")), 120_000);
  });
  child.send({ kind: "start", passes });
  try {
    assert.equal(await result, true); assert.deepEqual(await terminal, [0, null]);
    assert.deepEqual(output, [], "private caller/financial context never enters child output");
    assert.deepEqual(await readdir(folder), [], "no patient payload or private cache files");
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await terminal; }
    await rm(folder, { recursive: true, force: true });
  }
});
