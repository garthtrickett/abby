import assert from "node:assert/strict";
import test from "node:test";
import { runOrderedBrowserE2E } from "../../scripts/ordered-browser-e2e.mjs";

test("E2E-250 setting browsers execute in distinct observed orders with actual overlap", { timeout: 180_000 }, async () => {
  const files = ["test/browser/host-dashboard-identity.spec.ts", "test/browser/local-automation.spec.ts"];
  const pattern = "E2E-211|E2E-248";
  const forward = await runOrderedBrowserE2E(files, { pattern, workers: 2,
    onEvent: event => process.stdout.write(`forward ${event.kind} ${event.test.file}:${event.test.line} active=${event.activeTests}\n`) });
  assert.equal(forward.passed, 2);
  assert.deepEqual(forward.startOrder.map(item => item.file), files);
  assert.equal(forward.peakActiveTests, 2, "forward browser cases did not overlap");
  const reverse = await runOrderedBrowserE2E([...files].reverse(), { pattern, workers: 2,
    onEvent: event => process.stdout.write(`reverse ${event.kind} ${event.test.file}:${event.test.line} active=${event.activeTests}\n`) });
  assert.equal(reverse.passed, 2);
  assert.deepEqual(reverse.startOrder.map(item => item.file), [...files].reverse());
  assert.equal(reverse.peakActiveTests, 2, "reverse browser cases did not overlap");
  await assert.rejects(runOrderedBrowserE2E(files, { pattern, workers: 0 }), /invalid browser worker count/);
  await assert.rejects(runOrderedBrowserE2E([files[0]!, files[0]!], { pattern }), /invalid browser files/);
  await assert.rejects(runOrderedBrowserE2E(files, { pattern: "E2E-DOES-NOT-EXIST" }), /browser discovery failed/);
});
