import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readOwnerJson } from "../../src/shared/owner-json.ts";

async function withFile(run: (path: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "abby-owner-json-"));
  try { await run(join(folder, "configuration.json")); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

async function assertClosed(path: string) {
  if (process.platform !== "linux") return;
  for (const fd of await readdir("/proc/self/fd")) {
    let target: string;
    try { target = await readlink(`/proc/self/fd/${fd}`); }
    catch { continue; } // The directory reader's descriptor may have closed.
    assert.notEqual(target, path, "the owner configuration descriptor must be closed");
  }
}

test("owner JSON reads use the exact byte bound and observe fresh contents", async () => {
  await withFile(async path => {
    const value = { label: "synthetic é" }, encoded = JSON.stringify(value);
    const bytes = Buffer.byteLength(encoded);
    await writeFile(path, encoded, { mode: 0o600 });
    assert.deepEqual(await readOwnerJson(path, bytes), value);
    await assert.rejects(readOwnerJson(path, bytes - 1));
    await writeFile(path, JSON.stringify({ label: "changed" }));
    assert.deepEqual(await readOwnerJson(path, 8192), { label: "changed" });
    await assertClosed(path);
  });
});

test("owner JSON closes its descriptor after parsing and ownership failures", async () => {
  await withFile(async path => {
    await writeFile(path, "invalid JSON", { mode: 0o600 });
    await assert.rejects(readOwnerJson(path, 8192));
    await assertClosed(path);
    await writeFile(path, "{}");
    await chmod(path, 0o644);
    await assert.rejects(readOwnerJson(path, 8192));
    await assertClosed(path);
  });
});

test("owner JSON rejects a named pipe without waiting for a writer", {
  skip: process.platform !== "linux", timeout: 10_000,
}, async () => {
  await withFile(async path => {
    await promisify(execFile)("mkfifo", ["-m", "600", path]);
    await assert.rejects(readOwnerJson(path, 8192));
    await assertClosed(path);
  });
});
