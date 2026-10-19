import assert from "node:assert/strict";
import test from "node:test";
import { bindOutboundVoiceRuntime } from "../../src/voice/outbound-runtime.ts";
import { outboundRuntimeOwnersFixture } from "../support/outbound-runtime-owners.ts";
import { value } from "../support/outbound-records.ts";

for (const engine of ["abby", "vapi"] as const) {
  test(`synthetic ${engine} adapter shares actual native launch and independently guarded terminal owner`, async t => {
    const f = await outboundRuntimeOwnersFixture({ engine }); t.after(f.close);
    assert.deepEqual(value(await f.launchSelected()), { kind: "accepted", capacity: "held" }); assert.equal(f.held.size, 1);
    assert.equal(f.attempt().value.provider.bindingDigest, f.selected.terminal.binding().bindingDigest);
    assert.deepEqual(value(await f.inspect()), { kind: "terminal", released: true }); assert.equal(f.held.size, 0);
    assert.equal((await f.launchSelected()).ok, false); assert.equal(f.calls.length, 1);
  });
  test(`synthetic ${engine} unknown completion cannot release a held call`, async t => {
    const f = await outboundRuntimeOwnersFixture({ engine }); t.after(f.close);
    assert.equal(value(await f.launchSelected()).kind, "accepted"); f.runtimeState.terminal = "unknown";
    assert.deepEqual(value(await f.inspect()), { kind: "held" }); assert.equal(f.held.size, 1);
  });
  test(`synthetic ${engine} adapter cannot bypass current launch denial`, async t => {
    const f = await outboundRuntimeOwnersFixture({ engine }); t.after(f.close); f.deny("approveLaunch");
    assert.equal((await f.launchSelected()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.burned.size, 0);
  });
  test(`switching away from uncertain ${engine} cannot replay the effect or release its original call`, async t => {
    const f = await outboundRuntimeOwnersFixture({ engine }); t.after(f.close); f.controls.mode = "unknown";
    assert.deepEqual(value(await f.launchSelected()), { kind: "unknown", capacity: "held" });
    f.controls.mode = "accepted"; f.controls.providerDigest = "d".repeat(64);
    const next = value(bindOutboundVoiceRuntime(f.adapter)); Object.assign(f.ports, { provider: next.launch });
    assert.equal((await value(f.make()).launchOnce(f.binding, new AbortController().signal)).ok, false);
    assert.equal((await f.inspect()).ok, false); assert.equal(f.calls.length, 1); assert.equal(f.held.size, 1);
  });
}
