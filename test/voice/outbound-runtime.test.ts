import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { bindOutboundVoiceRuntime } from "../../src/voice/outbound-runtime.ts";
import type { OutboundVoiceRuntimeAdapter, OutboundRuntimeCall, OutboundRuntimeTerminalResult } from "../../src/voice/outbound-runtime.ts";
import { value } from "../support/outbound-records.ts";

function fixture() {
  const payload: OutboundRuntimeCall = { effectRef: randomUUID(), capacityAllocationRef: randomUUID(), number: "+12025550123", profileRef: "generic" };
  const binding = { ref: "twilio-abby", bindingDigest: "b".repeat(64), profileRef: "generic" };
  let launches = 0, lookups = 0, fences = 0;
  const adapter: { -readonly [K in keyof OutboundVoiceRuntimeAdapter]: OutboundVoiceRuntimeAdapter[K] } = { binding: () => binding,
    launchOnce: async (p, _s, gate, ack) => { launches++; if (!await gate()) return { kind: "definitiveUnsent" }; ack(p.effectRef); return { kind: "accepted", effectRef: p.effectRef }; },
    inspectTerminal: async identity => { lookups++; return { kind: "terminal", complete: true, ...identity,
      provider: { ref: binding.ref, bindingDigest: binding.bindingDigest }, endedAt: "2026-11-01T10:00:00.000Z", observedAt: "2026-11-01T10:00:01.000Z" }; } };
  const runtime = () => value(bindOutboundVoiceRuntime(adapter));
  return { payload, binding, adapter, runtime, signal: new AbortController().signal,
    gate: async () => { fences++; return true; }, get launches() { return launches; }, get lookups() { return lookups; }, get fences() { return fences; } };
}
test("one selected runtime supplies frozen launch and projected completion identities", async () => {
  const f = fixture(), runtime = f.runtime(); let acks = 0;
  assert.equal(Object.isFrozen(runtime), true); assert.equal(Object.isFrozen(runtime.launch), true); assert.equal(Object.isFrozen(runtime.terminal), true);
  assert.deepEqual(runtime.launch.binding(), f.binding); assert.deepEqual(runtime.terminal.binding(), { ref: f.binding.ref, bindingDigest: f.binding.bindingDigest });
  assert.deepEqual(await runtime.launch.launchOnce(f.payload, f.signal, f.gate, () => { acks++; }), { kind: "accepted", effectRef: f.payload.effectRef });
  const { effectRef, capacityAllocationRef } = f.payload;
  assert.equal((await runtime.terminal.inspectTerminal({ effectRef, capacityAllocationRef }, f.signal)).kind, "terminal");
  assert.equal(f.launches, 1); assert.equal(f.fences, 1); assert.equal(f.lookups, 1); assert.equal(acks, 1);
});
for (const field of ["ref", "bindingDigest", "profileRef"] as const)
  test(`runtime ${field} rotation refuses both previously selected ports`, async () => {
    const f = fixture(), runtime = f.runtime(); f.binding[field] = field === "bindingDigest" ? "c".repeat(64) : "changed";
    assert.throws(() => runtime.launch.binding()); assert.throws(() => runtime.terminal.binding());
    assert.deepEqual(await runtime.launch.launchOnce(f.payload, f.signal, f.gate, () => {}), { kind: "definitiveUnsent" });
    const { effectRef, capacityAllocationRef } = f.payload;
    assert.deepEqual(await runtime.terminal.inspectTerminal({ effectRef, capacityAllocationRef }, f.signal), { kind: "unknown" }); assert.equal(f.launches, 0); assert.equal(f.lookups, 0);
  });
test("replacement adapter methods cannot replace the captured selected implementation", async () => {
  const f = fixture(), runtime = f.runtime(); Object.assign(f.adapter, { launchOnce: async () => { throw Error("foreign"); }, inspectTerminal: async () => ({ kind: "unknown" }) });
  assert.equal((await runtime.launch.launchOnce(f.payload, f.signal, f.gate, () => {})).kind, "accepted"); assert.equal(f.launches, 1);
});
test("a repeated dispatch fence never invokes the clinic gate twice", async () => {
  const f = fixture(); let second: boolean | undefined;
  f.adapter.launchOnce = async (p, _s, gate, ack) => { assert.equal(await gate(), true); second = await gate(); ack(p.effectRef); ack(p.effectRef); return { kind: "accepted", effectRef: p.effectRef }; };
  let acks = 0; assert.equal((await f.runtime().launch.launchOnce(f.payload, f.signal, f.gate, () => { acks++; })).kind, "accepted");
  assert.equal(second, false); assert.equal(f.fences, 1); assert.equal(acks, 1);
});
test("rotation during clinic gate wait prevents dispatch admission", async () => {
  const f = fixture(), runtime = f.runtime(); let accepted = false;
  assert.deepEqual(await runtime.launch.launchOnce(f.payload, f.signal, async () => { f.binding.bindingDigest = "c".repeat(64); return true; }, () => { accepted = true; }), { kind: "unknown" });
  assert.equal(accepted, false);
});
for (const mode of ["noFence", "foreignAck", "foreignResult", "error", "definitiveUnsent"] as const)
  test(`invoked ${mode} cannot manufacture accepted truth or retry permission`, async () => {
    const f = fixture(); let acks = 0;
    f.adapter.launchOnce = async (p, _s, gate, ack) => {
      if (mode === "error") throw Error("private provider message");
      if (mode === "definitiveUnsent") return { kind: "definitiveUnsent" };
      if (mode !== "noFence") await gate();
      if (mode === "foreignAck") ack(randomUUID());
      return mode === "foreignAck" ? { kind: "unknown" } : { kind: "accepted", effectRef: mode === "foreignResult" ? randomUUID() : p.effectRef };
    };
    assert.deepEqual(await f.runtime().launch.launchOnce(f.payload, f.signal, f.gate, () => { acks++; }), { kind: "unknown" }); assert.equal(acks, 0);
  });
test("known exact ACK survives later cancellation, configuration rotation and observer failure", async () => {
  const f = fixture(), controller = new AbortController();
  f.adapter.launchOnce = async (p, _s, gate, ack) => { await gate(); ack(p.effectRef); f.binding.bindingDigest = "c".repeat(64); controller.abort(); throw Error("private response lost after ACK"); };
  assert.deepEqual(await f.runtime().launch.launchOnce(f.payload, controller.signal, f.gate, () => {}), { kind: "accepted", effectRef: f.payload.effectRef });
});
test("an ACK observer cannot mutate the captured accepted effect reference", async () => {
  const f = fixture(), original = f.payload.effectRef;
  assert.deepEqual(await f.runtime().launch.launchOnce(f.payload, f.signal, f.gate, () => { Object.assign(f.payload, { effectRef: randomUUID() }); throw Error("observer failed"); }),
    { kind: "accepted", effectRef: original });
});
test("aborted adapter and late fence cannot issue a late clinic admission", async () => {
  const f = fixture(), controller = new AbortController(); let late!: () => Promise<boolean>, entered!: () => void;
  const began = new Promise<void>(r => { entered = r; });
  f.adapter.launchOnce = async (_p, _s, gate) => { late = gate; entered(); return new Promise(() => {}); };
  const result = f.runtime().launch.launchOnce(f.payload, controller.signal, f.gate, () => {}); await began; controller.abort();
  assert.deepEqual(await result, { kind: "unknown" }); assert.equal(await late(), false); assert.equal(f.fences, 0);
});
test("runtime payload is a frozen minimal snapshot without clinic context or mutable caller references", async () => {
  const f = fixture(); f.adapter.launchOnce = async (p, _s, gate, ack) => {
    assert.equal(Object.isFrozen(p), true); Object.assign(f.payload, { number: "+12025550999" }); assert.equal(p.number, "+12025550123");
    assert.deepEqual(Object.keys(p).sort(), ["capacityAllocationRef", "effectRef", "number", "profileRef"]); await gate(); ack(p.effectRef); return { kind: "accepted", effectRef: p.effectRef };
  };
  assert.equal((await f.runtime().launch.launchOnce(f.payload, f.signal, f.gate, () => {})).kind, "accepted");
});
for (const patch of [{ profileRef: "foreign" }, { patientId: "21" }, { number: "not-a-number" }, { capacityAllocationRef: "private-call-id" }])
  test(`malformed or excessive launch payload refuses before invoking adapter: ${Object.keys(patch)[0]}`, async () => {
    const f = fixture(); assert.equal((await f.runtime().launch.launchOnce({ ...f.payload, ...patch }, f.signal, f.gate, () => {})).kind, "definitiveUnsent"); assert.equal(f.launches, 0);
  });
for (const patch of [{ complete: false }, { effectRef: randomUUID() }, { capacityAllocationRef: randomUUID() }, { provider: { ref: "foreign", bindingDigest: "c".repeat(64) } },
  { endedAt: "bad-time" }, { observedAt: "2020-01-01T00:00:00.000Z" }, { providerCallId: "private-provider-id" }])
  test(`unsupported completion truth stays unknown: ${Object.keys(patch)[0]}`, async () => {
    const f = fixture(), inspect = f.adapter.inspectTerminal.bind(f.adapter);
    f.adapter.inspectTerminal = async (i, s) => ({ ...await inspect(i, s), ...patch }) as OutboundRuntimeTerminalResult;
    const { effectRef, capacityAllocationRef } = f.payload;
    assert.deepEqual(await f.runtime().terminal.inspectTerminal({ effectRef, capacityAllocationRef }, f.signal), { kind: "unknown" });
  });
for (const kind of ["active", "unknown"] as const)
  test(`normalized ${kind} cannot become terminal`, async () => {
    const f = fixture(); f.adapter.inspectTerminal = async () => ({ kind }); const { effectRef, capacityAllocationRef } = f.payload;
    assert.deepEqual(await f.runtime().terminal.inspectTerminal({ effectRef, capacityAllocationRef }, f.signal), { kind });
  });
test("completion during runtime rotation remains unknown", async () => {
  const f = fixture(), inspect = f.adapter.inspectTerminal.bind(f.adapter);
  f.adapter.inspectTerminal = async (i, s) => { const r = await inspect(i, s); f.binding.profileRef = "rotated"; return r; };
  const runtime = f.runtime(), { effectRef, capacityAllocationRef } = f.payload;
  assert.deepEqual(await runtime.terminal.inspectTerminal({ effectRef, capacityAllocationRef }, f.signal), { kind: "unknown" });
});
test("missing completion implementation cannot silently install a launch-only runtime", () => {
  const f = fixture(); Object.assign(f.adapter, { inspectTerminal: undefined }); assert.deepEqual(bindOutboundVoiceRuntime(f.adapter), { ok: false, error: { kind: "invalidConfig" } });
});
