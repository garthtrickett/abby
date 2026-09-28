import assert from "node:assert/strict";
import test from "node:test";
import { EffectWorkLoop } from "../../src/core/effect-work-loop.ts";
import { ok } from "../../src/core/model.ts";
import type { TimerPort } from "../../src/core/timer.ts";

test("effect recovery starts immediately, coalesces overlap, and stops without another tick", async () => {
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];
  let nextHandle = 0;
  const timer: TimerPort = {
    schedule(callback, delayMs) {
      const handle = ++nextHandle;
      scheduled.set(handle, callback);
      delays.push(delayMs);
      return handle;
    },
    cancel(handle) { scheduled.delete(handle as number); },
  };
  let finish!: (result: ReturnType<typeof ok<{ scanned: number; processed: number; recovered: number; deferred: number; failed: never[] }>>) => void;
  let calls = 0;
  let observed!: () => void;
  const completed = new Promise<void>(resolve => { observed = resolve; });
  const loop = new EffectWorkLoop({ recover: async () => {
    calls += 1;
    return new Promise(resolve => { finish = resolve; });
  } }, result => { assert.equal(result.ok, true); observed(); },
  { clock: () => "2026-09-28T10:00:00.000Z", intervalMs: 250, timer });
  loop.start();
  loop.start();
  assert.deepEqual(delays, [0]);
  const first = scheduled.values().next().value!;
  scheduled.clear();
  first();
  const concurrent = loop.runOnce();
  assert.equal(calls, 1);
  finish(ok({ scanned: 0, processed: 0, recovered: 0, deferred: 0, failed: [] }));
  assert.equal((await concurrent).ok, true);
  await completed;
  assert.deepEqual(delays, [0, 250]);
  assert.equal(scheduled.size, 1);
  await loop.stop();
  assert.equal(scheduled.size, 0);
});
