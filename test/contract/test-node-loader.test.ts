import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url), launcher = fileURLToPath(new URL("scripts/test-node.mjs", root));
const fixture = new URL("test/support/test-node-child.ts", root);
const expected = { sourceUrl: fixture.href, scope: "loader-fixture", marker: true, count: 1 };

test("test launcher transforms actual project TypeScript without moving module URLs or relative imports", () => {
  const result = spawnSync(process.execPath, [launcher, fileURLToPath(fixture)], { cwd: fileURLToPath(root), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), expected);
});

test("a typed recovery child can inherit the absolute loader from an empty working directory", { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "abby-loader-empty-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = fork(fileURLToPath(fixture), [], { cwd, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const errors: string[] = []; child.stderr?.on("data", b => errors.push(String(b)));
  const result = once(child, "message"), terminal = once(child, "exit");
  assert.deepEqual((await result)[0], expected); assert.deepEqual(await terminal, [0, null]); assert.deepEqual(errors, []);
});

test("a child failure remains a failed test command", () => {
  const result = spawnSync(process.execPath, [launcher, "--input-type=module", "-e", "process.exit(7)"], { cwd: fileURLToPath(root), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 7); assert.equal(result.signal, null);
});

test("termination is forwarded and retains the actual child signal", { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [launcher, "--input-type=module", "-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { cwd: fileURLToPath(root), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  const ready = once(child.stdout!, "data"), terminal = once(child, "exit"); await ready;
  assert.ok(child.kill("SIGTERM")); assert.deepEqual(await terminal, [null, "SIGTERM"]);
});


test("owned TypeScript loads with Node's built-in type stripping disabled", () => {
  const args = ["--no-experimental-strip-types"];
  const ordinary = spawnSync(process.execPath, [...args, fileURLToPath(fixture)], { cwd: fileURLToPath(root), encoding: "utf8", timeout: 10000 });
  assert.notEqual(ordinary.status, 0);
  const result = spawnSync(process.execPath, [...args, launcher, fileURLToPath(fixture)], { cwd: fileURLToPath(root), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), expected);
});
