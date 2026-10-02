import assert from "node:assert/strict";
import { resolve } from "node:path";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = JSON.parse(process.argv[2] ?? "null");
assert.ok(options && typeof options === "object" && !Array.isArray(options), "Node scheduling options required");
assert.ok(Object.keys(options).every(key => ["files", "concurrency", "pattern"].includes(key)), "unknown Node scheduling option");
const { files, concurrency = 1, pattern } = options;
assert.ok(Array.isArray(files) && files.length > 0 && new Set(files).size === files.length &&
  files.every(file => /^test\/[a-z-]+\/[a-z0-9-]+\.test\.ts$/.test(file)), "invalid Node test files");
assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0, "invalid Node concurrency");
assert.ok(pattern === undefined || (typeof pattern === "string" && pattern.length > 0), "invalid Node name pattern");

const planned = files.map(file => resolve(root, file));
const names = new Map(planned.map((file, index) => [file, files[index]]));
const dispatched = [];
const active = new Set();
const finished = new Set();
let failure;
const emit = (kind, name) => process.stdout.write(`ABBY_NODE_EVENT ${JSON.stringify({ kind,
  file: names.get(name), activeFiles: active.size })}\n`);
// This separate CLI owns a fresh runner, even when launched by an enclosing test worker.
delete process.env.NODE_TEST_CONTEXT;
const stream = run({ files: planned, concurrency, execArgv: [],
  ...(pattern === undefined ? {} : { testNamePatterns: [pattern] }),
  setup(reporter) {
    reporter.on("test:dequeue", data => {
      if (!names.has(data.name)) return;
      if (data.name !== planned[dispatched.length] || active.has(data.name) || finished.has(data.name)) {
        failure ??= new Error("Node file dispatch differs from the requested order");
      }
      dispatched.push(data.name);
      active.add(data.name);
      emit("dispatched", data.name);
    });
    reporter.on("test:complete", data => {
      if (!names.has(data.name)) return;
      if (!active.delete(data.name) || finished.has(data.name) || !data.details.passed) {
        failure ??= new Error("Node file did not complete successfully exactly once");
      }
      finished.add(data.name);
      emit("finished", data.name);
    });
    reporter.on("test:fail", () => { process.exitCode = 1; });
    reporter.on("test:summary", data => { if (!data.success) process.exitCode = 1; });
  },
});
for await (const chunk of tap(stream)) process.stdout.write(chunk);
if (failure) throw failure;
assert.deepEqual(dispatched, planned, "Node files did not all dispatch");
assert.equal(finished.size, planned.length, "Node files did not all finish");
assert.equal(active.size, 0, "Node files remain active");
