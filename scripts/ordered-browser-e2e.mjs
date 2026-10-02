import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "node_modules/playwright/cli.js");
const marker = "ABBY_BROWSER_EVENT ";

function launch(args, env, observe = () => {}) {
  const child = spawn(process.execPath, [cli, "test", ...args], { cwd: root, env,
    stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let pendingLine = "";
  let failure;
  let escalation;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    escalation.unref();
  };
  const fail = error => { failure ??= error; stop(); };
  const deadline = setTimeout(() => fail(new Error("browser command timed out")), 240_000);
  deadline.unref();
  const capture = chunk => {
    output = (output + chunk).slice(-24_000);
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", capture);
  child.stdout.on("data", chunk => {
    capture(chunk);
    pendingLine += chunk;
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop().slice(-24_000);
    for (const line of lines) {
      if (!line.startsWith(marker)) continue;
      try { observe(JSON.parse(line.slice(marker.length))); }
      catch (error) { fail(error); }
    }
  });
  const done = new Promise((resolveDone, reject) => {
    child.once("error", error => { failure ??= error; });
    child.once("close", code => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      failure || code !== 0
        ? reject(new Error(`Playwright command failed (${code}): ${failure?.message ?? "nonzero exit"}\n${output}`))
        : resolveDone();
    });
  });
  // The scheduler may be waiting for the start event when a child fails to start.
  void done.catch(() => {});
  return { done, stop };
}

function discover(report, files) {
  assert.ok(Array.isArray(report.suites) && Array.isArray(report.errors) && report.errors.length === 0,
    "invalid browser discovery report");
  const byFile = new Map(files.map(file => [file, []]));
  const visit = suite => {
    for (const spec of suite.specs ?? []) {
      const file = relative(root, resolve(report.config.rootDir, spec.file));
      assert.ok(byFile.has(file), `unexpected discovered file: ${file}`);
      assert.ok(Number.isSafeInteger(spec.line) && spec.line > 0 && typeof spec.title === "string" && spec.title,
        "invalid discovered test");
      assert.equal(spec.tests.length, 1, "ordered browser evidence requires one configured project");
      assert.equal(spec.tests[0].expectedStatus, "passed", "skipped or expected-failure cases are not evidence");
      byFile.get(file).push(Object.freeze({ file, line: spec.line, title: spec.title }));
    }
    for (const nested of suite.suites ?? []) visit(nested);
  };
  for (const suite of report.suites) visit(suite);
  const cases = files.flatMap(file => {
    const selected = byFile.get(file);
    assert.ok(selected.length > 0, `${file} has no selected browser cases`);
    return selected;
  });
  assert.equal(new Set(cases.map(test => JSON.stringify(test))).size, cases.length,
    "duplicate browser case");
  return cases;
}

/** Runs actual cases in the supplied file order; observed starts, not CLI filters, govern dispatch. */
export async function runOrderedBrowserE2E(files, { pattern, workers = 1, onEvent = () => {} }) {
  assert.ok(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length &&
    files.every(file => /^test\/browser\/[a-z0-9-]+\.spec\.ts$/.test(file)), "invalid browser files");
  assert.ok(typeof pattern === "string" && pattern.length > 0, "browser pattern required");
  assert.ok(Number.isSafeInteger(workers) && workers > 0, "invalid browser worker count");
  const orderedFiles = [...files];
  const artifacts = await mkdtemp(join(tmpdir(), "abby-browser-order-"));
  const tasks = [];
  const active = new Set();
  const startOrder = [];
  let runningTests = 0;
  let peakActiveTests = 0;
  let failed;
  try {
    const reportPath = join(artifacts, "discovery.json");
    const listing = launch([...orderedFiles, "--grep", pattern, "--list", "--reporter=json"],
      { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath });
    tasks.push(listing);
    try { await listing.done; }
    catch (error) { throw new Error(`browser discovery failed: ${error.message}`); }
    const cases = discover(JSON.parse(await readFile(reportPath, "utf8")), orderedFiles);
    const scheduled = [];
    let nextIndex = 0;
    const prepare = index => {
      const test = cases[index];
      const permitPath = join(artifacts, `${index}.permit`);
      let phase = "pending";
      let resolveReady;
      let rejectReady;
      let resolveStarted;
      let rejectStarted;
      const readiness = new Promise((resolveWarm, reject) => { resolveReady = resolveWarm; rejectReady = reject; });
      const beginning = new Promise((resolveBegin, reject) => { resolveStarted = resolveBegin; rejectStarted = reject; });
      void readiness.catch(() => {});
      void beginning.catch(() => {});
      const titlePattern = test.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const task = launch([`${test.file}:${test.line}`, "--grep", titlePattern, "--workers=1", "--retries=0",
        "--reporter=./scripts/browser-order-reporter.cjs", "--output", join(artifacts, String(index))],
      { ...process.env, ABBY_BROWSER_ORDER_GATE: permitPath }, event => {
        assert.equal(event.file, test.file, "unexpected browser file started");
        assert.equal(event.line, test.line, "unexpected browser test line");
        assert.equal(event.title, test.title, "unexpected browser test title");
        if (event.kind === "prepared") {
          assert.equal(phase, "pending", "duplicate browser reporter start");
          phase = "prepared";
        } else if (event.kind === "ready") {
          assert.equal(phase, "prepared", "invalid browser readiness");
          phase = "ready";
          resolveReady();
        } else if (event.kind === "started") {
          assert.equal(phase, "ready", "duplicate browser test start");
          phase = "started";
          runningTests += 1;
          peakActiveTests = Math.max(peakActiveTests, runningTests);
          startOrder.push(test);
          onEvent({ kind: "started", test, activeTests: runningTests });
          resolveStarted();
        } else {
          assert.ok(event.kind === "finished" && phase === "started", "invalid browser finish");
          assert.equal(event.status, "passed", "browser case did not pass");
          phase = "finished";
          runningTests -= 1;
          onEvent({ kind: "finished", test, activeTests: runningTests });
        }
      });
      const completed = task.done.then(() => {
        assert.equal(phase, "finished", "browser case did not execute to completion");
      });
      const tracked = { stop: task.stop, done: completed, readiness, beginning, permitPath };
      scheduled[index] = tracked;
      tasks.push(tracked);
      active.add(tracked);
      void completed.then(() => { active.delete(tracked); fillSlots(); }, error => {
        failed ??= error;
        active.delete(tracked);
        rejectReady(error);
        rejectStarted(error);
      });
    };
    function fillSlots() {
      try {
        while (!failed && active.size < workers && nextIndex < cases.length) prepare(nextIndex++);
      } catch (error) { failed ??= error; }
    }
    fillSlots();
    for (let index = 0; index < cases.length; index += 1) {
      if (failed) throw failed;
      while (!scheduled[index]) {
        if (failed) throw failed;
        assert.ok(active.size > 0, "no browser worker can schedule the next case");
        await Promise.race([...active].map(task => task.done));
        if (failed) throw failed;
        fillSlots();
      }
      const task = scheduled[index];
      await task.readiness;
      if (failed) throw failed;
      // Workers warm concurrently. A case is released only after the previous case's actual start.
      const unpublishedPermit = `${task.permitPath}.pending`;
      await writeFile(unpublishedPermit, "run\n", { mode: 0o600, flag: "wx" });
      await rename(unpublishedPermit, task.permitPath);
      await task.beginning;
    }
    await Promise.all(tasks.map(task => task.done));
    assert.deepEqual(startOrder, cases, "observed browser start order changed");
    assert.equal(runningTests, 0);
    await rm(artifacts, { recursive: true, force: true });
    return { passed: cases.length, startOrder, peakActiveTests };
  } catch (error) {
    for (const task of tasks) task.stop();
    await Promise.allSettled(tasks.map(task => task.done));
    throw new Error(`${error.message}\nBrowser artifacts: ${artifacts}`);
  }
}
