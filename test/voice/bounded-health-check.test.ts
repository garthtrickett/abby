import assert from "node:assert/strict";
import test from "node:test";
import { boundedHealthCheck } from "../../src/standalone/bounded-health-check.ts";

test("E2E-176 stalled database health reads return false without piling up probes and later recover", async () => {
  let finish!: () => void;
  const stalled = new Promise<void>(resolve => { finish = resolve; });
  let probes = 0;
  const healthy = boundedHealthCheck(async () => {
    probes += 1;
    if (probes === 1) await stalled;
  }, 20);
  assert.deepEqual(await Promise.all([healthy(), healthy()]), [false, false]);
  assert.equal(probes, 1);
  assert.equal(await healthy(), false);
  assert.equal(probes, 1);
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(await healthy(), true);
  assert.equal(probes, 2);
});
