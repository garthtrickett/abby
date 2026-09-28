import assert from "node:assert/strict";
import test from "node:test";
import { ok } from "../../src/core/model.ts";
import { VoiceWorkLoop } from "../../src/voice/voice-work-loop.ts";
import type { WorkTimer } from "../../src/voice/voice-work-loop.ts";

test("worker schedules one tick at a time and stop cancels the next tick", async () => {
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];
  let nextHandle = 0;
  const timer: WorkTimer = {
    schedule(callback, delayMs) {
      const handle = ++nextHandle;
      scheduled.set(handle, callback);
      delays.push(delayMs);
      return handle;
    },
    cancel(handle) { scheduled.delete(handle as number); },
  };
  let finishExpiry!: (result: ReturnType<typeof ok<number>>) => void;
  let expiryCalls = 0;
  let recoveryCalls = 0;
  let observed!: () => void;
  const completed = new Promise<void>(resolve => { observed = resolve; });
  const worker = new VoiceWorkLoop(
    { expireDue: async () => {
      expiryCalls += 1;
      return new Promise(resolve => { finishExpiry = resolve; });
    } },
    { recover: async () => {
      recoveryCalls += 1;
      return ok({ scanned: 0, dispatched: 0, deferred: 0 });
    }, wake: async () => ok({ kind: "none" as const }) },
    result => { assert.equal(result.ok, true); observed(); },
    { clock: () => "2026-09-28T10:00:00.000Z", intervalMs: 250, timer },
  );
  worker.start();
  worker.start();
  assert.deepEqual(delays, [0]);
  const first = scheduled.values().next().value!;
  scheduled.clear();
  first();
  const concurrent = worker.runOnce();
  assert.equal(expiryCalls, 1);
  assert.equal(recoveryCalls, 0);
  finishExpiry(ok(0));
  assert.equal((await concurrent).ok, true);
  await completed;
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(delays, [0, 250]);
  assert.equal(scheduled.size, 1);
  await worker.stop();
  assert.equal(scheduled.size, 0);
});
