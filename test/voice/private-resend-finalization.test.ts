import assert from "node:assert/strict";
import test from "node:test";
import { PrivateResendVoiceInput } from "../../src/standalone/private-resend-voice-input.ts";
import type { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const menu = gate<{ ok: true; value: { count: number; hasNext: boolean; hasPrevious: boolean } } | { ok: false }>();
  let played = false, stopped = false;
  const selected: number[] = [];
  const owner = { workflow: "confirmationResend", closed: false,
    listResendAppointments: () => menu.promise, resendMenuPlaybackCompleted: async () => played,
    selectResendAppointment: async (choice: number) => { selected.push(choice); return { ok: true, value: { requestRef: "opaque-request" } }; },
  } as unknown as ClinikoCallFlow;
  const lifetime = new AbortController();
  const input = new PrivateResendVoiceInput({ owner: () => owner, signal: lifetime.signal, present: async () => true,
    input: { claim: () => true, start: () => true, blocked: () => true, accept: async () => "verified", stop() { stopped = true; } } });
  return { input, menu, selected, lifetime, play() { played = true; }, get stopped() { return stopped; } };
}
const ready = { ok: true as const, value: { count: 2, hasNext: false, hasPrevious: false } };
const settled = () => new Promise<void>(done => setImmediate(done));

test("a post-play resend choice survives menu task finalization without another keypress", async () => {
  const f = fixture();
  try {
    assert.equal(await f.input.accept("#"), "pending");
    f.play(); f.menu.resolve(ready);
    // The public list continuation publishes the menu before its task's finally.
    // Enqueue the caller choice in that genuine promise ordering gap.
    await Promise.resolve().then(() => f.input.accept("2")); await settled();
    assert.deepEqual(f.selected, [2]);
  } finally { f.input.stop(); }
});

test("an unplayed resend digit is not retained when the menu later finishes", async () => {
  const f = fixture();
  try {
    await f.input.accept("#"); await f.input.accept("1");
    assert.deepEqual(f.selected, []);
    f.play(); f.menu.resolve(ready); await settled();
    assert.deepEqual(f.selected, [], "later playback cannot grant an earlier digit authority");
    await f.input.accept("2"); await settled(); assert.deepEqual(f.selected, [2]);
  } finally { f.input.stop(); }
});

test("concurrent post-play choices during finalization select at most one appointment", async () => {
  const f = fixture();
  try {
    await f.input.accept("#"); f.play(); f.menu.resolve(ready);
    await Promise.all([Promise.resolve().then(() => f.input.accept("2")), Promise.resolve().then(() => f.input.accept("1"))]);
    await settled(); assert.deepEqual(f.selected, [2]);
  } finally { f.input.stop(); }
});

test("failed menu refresh and explicit stop cannot release a post-play resend choice", async () => {
  for (const mode of ["withdrawn", "stopped"] as const) {
    const f = fixture();
    try {
      await f.input.accept("#"); f.play();
      if (mode === "stopped") f.lifetime.abort();
      f.menu.resolve(mode === "withdrawn" ? { ok: false } : ready);
      await Promise.resolve().then(() => f.input.accept("2")); await settled();
      assert.deepEqual(f.selected, []); assert.equal(f.stopped, true);
    } finally { f.input.stop(); }
  }
});
