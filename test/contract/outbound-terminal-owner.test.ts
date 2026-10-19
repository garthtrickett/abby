import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundTerminalOwnerFixture as fixture } from "../support/outbound-terminal-owner.ts";
import { value } from "../support/outbound-records.ts";
import { decodeOutboundLaunchAttempt, encodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";


test("actual native v2 and exact provider metadata release one held place without launch or effect replay", async t => {
  const f = await fixture(); t.after(f.close); const before = f.claims;
  assert.deepEqual(value(await f.inspect()), { kind: "terminal", released: true });
  assert.equal(f.held.size, 0); assert.equal(f.released.size, 1); assert.equal(f.calls.length, 1); assert.equal(f.posts, 1);
  assert.ok(f.claims - before <= 8); assert.ok(f.claims <= 180);
  assert.deepEqual(value(await f.inspect()), { kind: "terminal", released: false });
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 1);
  assert.deepEqual(value(await f.ports.capacity.acquireOnce(f.attempt.capacityAllocationRef!, 1)), { kind: "alreadyUsed" });
});
for (const kind of ["active", "unknown"] as const)
  test(`provider ${kind} cannot release capacity by time or process absence`, async t => {
    const f = await fixture(); t.after(f.close); f.stateTerminal.provider = kind;
    f.state.now = "2026-11-03T00:00:00.000Z";
    assert.deepEqual(value(await f.inspect()), { kind: "held" }); assert.equal(f.held.size, 1); assert.equal(f.calls.length, 1);
  });
for (const operation of ["approveNativeSource", "readProviderTerminal", "releaseCapacity"] as const) {
  test(`separate ${operation} denial prevents provider observation or release`, async t => {
    const f = await fixture(); t.after(f.close); f.stateTerminal.denied = operation;
    assert.equal((await f.inspect()).ok, false); assert.equal(f.lookupCount, 0); assert.equal(f.held.size, 1);
  });
  test(`separate ${operation} withdrawal during provider wait retains capacity`, async t => {
    const f = await fixture(); t.after(f.close); f.stateTerminal.afterLookup = () => { f.stateTerminal.withdrawn = operation; };
    assert.equal((await f.inspect()).ok, false); assert.equal(f.lookupCount, 1); assert.equal(f.held.size, 1);
  });
}
for (const patch of [{ effectRef: randomUUID() }, { capacityAllocationRef: randomUUID() }, { complete: false },
  { provider: { ref: "foreign", bindingDigest: "0".repeat(64) } }, { endedAt: "2026-10-01T00:00:00.000Z" },
  { observedAt: "2027-01-01T00:00:00.000Z" }, { providerCallId: "private-provider-id" }])
  test(`foreign or unsupported terminal ${Object.keys(patch)[0]} cannot release`, async t => {
    const f = await fixture(); t.after(f.close); f.stateTerminal.proofPatch = patch;
    assert.equal((await f.inspect()).ok, false); assert.equal(f.held.size, 1);
  });
test("record permission withdrawal during storage waits is checked by final release fence", async t => {
  const f = await fixture(); t.after(f.close); f.stateTerminal.beforeRelease = () => { f.stateTerminal.readLive = false; };
  assert.equal((await f.inspect()).ok, false); assert.equal(f.held.size, 1); assert.equal(f.released.size, 0);
});
test("independent release grant withdrawal during storage waits cannot free capacity", async t => {
  const f = await fixture(); t.after(f.close); f.stateTerminal.beforeRelease = () => { f.stateTerminal.withdrawn = "releaseCapacity"; };
  assert.equal((await f.inspect()).ok, false); assert.equal(f.held.size, 1);
});
test("changing native allocation to another live place cannot borrow the old terminal call", async t => {
  const f = await fixture(); t.after(f.close); const other = randomUUID();
  assert.equal(value(await f.ports.capacity.acquireOnce(other, 2)).kind, "acquired");
  f.row.notes = value(encodeOutboundLaunchAttempt({ ...f.attempt, capacityAllocationRef: other }));
  assert.deepEqual(value(await f.inspect()), { kind: "held" }); assert.equal(f.held.size, 2);
});
test("legacy possible evidence cannot invent an allocation after a cold read", async t => {
  const f = await fixture(); t.after(f.close); const { capacityAllocationRef: _allocation, dncReferences: _dnc, ...legacy } = f.attempt;
  f.row.notes = value(encodeOutboundLaunchAttempt(legacy));
  const r = await f.inspect(); assert.ok(!r.ok && r.error.kind === "unrecoverable");
  assert.equal(f.lookupCount, 0); assert.equal(f.held.size, 1);
});
test("native closure during lookup requires a new exact observation, not a blind release", async t => {
  const f = await fixture(); t.after(f.close); f.stateTerminal.afterLookup = () => { f.row.recalled = true; f.row.recalled_at = f.state.now; };
  assert.equal((await f.inspect()).ok, false); assert.equal(f.held.size, 1);
  delete f.stateTerminal.afterLookup;
  assert.deepEqual(value(await f.inspect()), { kind: "terminal", released: true });
});
test("campaign cancellation blocks launch but cannot strand an independently proven ended call", async t => {
  const f = await fixture(); t.after(f.close); await f.cancelCampaign();
  assert.deepEqual(value(await f.inspect()), { kind: "terminal", released: true }); assert.equal(f.calls.length, 1);
});
test("captured current grants cannot be replaced after construction to recover a denied release", async t => {
  const f = await fixture(); t.after(f.close); f.stateTerminal.withdrawn = "releaseCapacity";
  Object.assign(f.terminalPorts.authority, { current: () => true });
  assert.equal((await f.inspect()).ok, false); assert.equal(f.held.size, 1);
});
test("abort during provider lookup leaves capacity held and emits no new call", async t => {
  const f = await fixture(); t.after(f.close); const controller = new AbortController();
  f.stateTerminal.afterLookup = async () => { controller.abort(); await new Promise<void>(() => {}); };
  assert.equal((await f.inspect(controller.signal)).ok, false); assert.equal(f.held.size, 1); assert.equal(f.calls.length, 1);
});
