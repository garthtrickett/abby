import assert from "node:assert/strict";
import test from "node:test";
import { err } from "../../src/core/model.ts";
import type { CallState, Result } from "../../src/core/model.ts";
import type { TimerPort } from "../../src/voice/timer.ts";
import { VoiceLeaseLoop } from "../../src/voice/voice-lease-loop.ts";
import type { VoiceSessionFailure } from "../../src/voice/voice-session.ts";

function manualTimer() {
  const pending = new Map<number, { callback: () => void; delayMs: number }>();
  let nextHandle = 0;
  const timer: TimerPort = {
    schedule(callback, delayMs) { const handle = ++nextHandle; pending.set(handle, { callback, delayMs }); return handle; },
    cancel(handle) { pending.delete(handle as number); },
  };
  function fire(): void {
    const [handle, job] = pending.entries().next().value!;
    pending.delete(handle);
    job.callback();
  }
  return { timer, pending, fire };
}

test("renewal retries a clock fault and stops when its lease is lost", async () => {
  const { timer, pending, fire } = manualTimer();
  let clockValid = false;
  let renewCalls = 0;
  const reported: string[] = [];
  let observed!: () => void;
  const loop = new VoiceLeaseLoop(
    { renew: async () => { renewCalls += 1; return err({ kind: "leaseLost" as const }); } },
    outcome => { reported.push(outcome.ok ? "renewed" : outcome.error.kind); observed(); },
    { timer, clock: () => clockValid ? "2026-09-28T10:00:00.000Z" : "invalid" },
  );
  loop.start();
  assert.equal(pending.values().next().value?.delayMs, 10_000);
  let done = new Promise<void>(resolve => { observed = resolve; });
  fire();
  await done;
  assert.deepEqual(reported, ["renewalUnavailable"]);
  assert.equal(renewCalls, 0);
  assert.equal(pending.values().next().value?.delayMs, 2_000);
  clockValid = true;
  done = new Promise<void>(resolve => { observed = resolve; });
  fire();
  await done;
  assert.deepEqual(reported, ["renewalUnavailable", "leaseLost"]);
  assert.equal(renewCalls, 1);
  assert.equal(pending.size, 0);
  await loop.stop();
});

test("stopping an in-flight renewal waits for its result and prevents rescheduling", async () => {
  const { timer, pending, fire } = manualTimer();
  let finishRenew!: (result: Result<CallState, VoiceSessionFailure>) => void;
  const loop = new VoiceLeaseLoop<CallState, VoiceSessionFailure>(
    { renew: () => new Promise(resolve => { finishRenew = resolve; }) },
    () => {},
    { timer, clock: () => "2026-09-28T10:00:00.000Z" },
  );
  loop.start();
  fire();
  let stopped = false;
  const stopping = loop.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finishRenew(err({ kind: "leaseLost" }));
  await stopping;
  assert.equal(pending.size, 0);
});
