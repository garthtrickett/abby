import assert from "node:assert/strict";
import test from "node:test";
import { outboundLaunchOwnerFixture } from "../support/outbound-launch-owner.ts";
import { decodeOutboundLaunchAttempt } from "../../src/cliniko/outbound-launch-attempt.ts";
import { encodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { value } from "../support/outbound-records.ts";

test("actual follow-up owner composes native campaign/contact/request/history/possible-attempt before one launch", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close);
  assert.deepEqual(value(await f.launch()), { kind: "accepted", capacity: "held" });
  assert.equal(f.posts, 1); assert.equal(f.calls.length, 1); assert.equal(f.held.size, 1);
  const retained = f.contactControls.rows.find(r => (r.recall_type as { links: { self: string } }).links.self.endsWith("/62"))!;
  assert.equal(value(decodeOutboundLaunchAttempt(retained.notes)).capacityAllocationRef, [...f.held][0]);
  assert.ok(f.claims <= 150 && f.claims > 0);
  assert.ok(f.burned.has(f.request.approvalRef) && f.burned.has(f.request.effectRef));
  assert.deepEqual(Object.keys(f.calls[0]!).sort(), ["capacityAllocationRef", "effectRef", "number", "profileRef"]);
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 1);
});
for (const operation of ["approveAudience", "approveProvider", "producerAdmitted", "approveLaunch"])
  test(`independent ${operation} denial prevents claims, retention and provider launch`, async t => {
    const f = await outboundLaunchOwnerFixture(); t.after(f.close); f.deny(operation);
    assert.equal((await f.launch()).ok, false); assert.equal(f.burned.size, 0); assert.equal(f.posts, 0); assert.equal(f.calls.length, 0);
  });
for (const race of ["campaign", "contact", "number", "permission", "quiet", "provider"] as const)
  test(`current ${race} change at final provider edge cannot launch`, async t => {
    const f = await outboundLaunchOwnerFixture(); t.after(f.close);
    f.controls.beforeEdge = async () => {
      if (race === "campaign") await f.cancelCampaign();
      if (race === "contact") f.state.live = false;
      if (race === "number") f.contactControls.patient.patient_phone_numbers = [{ number: "+61499999999", phone_type: "Mobile" }];
      if (race === "permission") f.retire();
      if (race === "quiet") f.state.now = "2026-11-02T08:00:00.000Z";
      if (race === "provider") f.controls.providerDigest = "f".repeat(64);
    };
    const result = await f.launch(); assert.ok(!result.ok || result.value.kind === "unknown");
    assert.equal(f.calls.length, 0); assert.equal(f.posts, 1); assert.ok(f.burned.has(f.request.effectRef));
    assert.equal(f.held.size, 1, "an invoked adapter needs independent recovery; no timeout/lease releases capacity");
  });
test("lost provider response keeps one possible call and capacity occupied without retry", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close); f.controls.mode = "unknown";
  assert.deepEqual(value(await f.launch()), { kind: "unknown", capacity: "held" });
  assert.equal(f.calls.length, 1); assert.equal(f.held.size, 1); assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 1);
});
test("known accepted launch survives later role/observer failure", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close); f.controls.mode = "loseAfterAck"; f.controls.afterAck = async () => f.retire();
  assert.deepEqual(value(await f.launch()), { kind: "accepted", capacity: "held" }); assert.equal(f.calls.length, 1);
});
test("lost native possible-attempt acknowledgement never invokes provider and releases only proven unused capacity", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close); f.controls.retainResponse = () => { throw new Error("Synthetic private lost record ACK"); };
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 1);
  assert.ok(f.burned.has(f.request.effectRef)); assert.equal(f.held.size, 0); assert.equal(f.released.size, 1);
});

test("captured current authority cannot be replaced after construction to recover a denied launch", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close); f.deny("approveLaunch");
  Object.assign(f.ports.authority, { allows: async () => true });
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0);
});
test("captured physical quota admission cannot be replaced to burn effects without known headroom", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close);
  for (let n = 0; n < 40; n++) assert.equal(f.budget.claim(), null);
  Object.assign(f.config.requests.rateBudget, { checkHeadroom: () => null });
  assert.equal((await f.launch()).ok, false); assert.equal(f.burned.size, 0); assert.equal(f.posts, 0);
});


test("reader-local consent time cannot authorize an expired review at dispatch time", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close);
  f.state.now = "2026-11-02T00:00:01.000Z";
  Object.assign(f.config.contact, { clock: () => "2026-11-02T00:00:00.000Z" });
  f.contactControls.rows.find(r => r.id === "101")!.notes = value(encodeOutboundContactReview({
    ...f.first, effectiveUntil: "2026-11-02T00:00:00.500Z" }));
  const owner = value(f.make());
  assert.equal((await owner.launchOnce(f.binding, new AbortController().signal)).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.posts, 0); assert.equal(f.burned.size, 0);
});

test("consent expiring during final native history wait cannot pass the provider edge", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close);
  f.state.now = "2026-11-02T00:00:00.000Z";
  f.contactControls.rows.find(r => r.id === "101")!.notes = value(encodeOutboundContactReview({
    ...f.first, effectiveUntil: "2026-11-02T00:00:00.500Z" }));
  let finalEdge = false;
  f.controls.beforeEdge = () => { finalEdge = true; };
  Object.assign(f.ports.history, { allowsHistoryRead: async () => {
    if (finalEdge) f.state.now = "2026-11-02T00:00:01.000Z";
    return true;
  } });
  const owner = value(f.make()), result = await owner.launchOnce(f.binding, new AbortController().signal);
  assert.ok(!result.ok || result.value.kind === "unknown");
  assert.equal(finalEdge, true); assert.equal(f.calls.length, 0); assert.equal(f.posts, 1);
  assert.equal(f.held.size, 1, "invoked adapters retain conservative capacity until independent recovery");
});


for (const operation of ["approveAudience", "approveProvider", "producerAdmitted", "approveLaunch"] as const)
  test(`independent ${operation} withdrawal during final native history wait cannot dispatch`, async t => {
    const f = await outboundLaunchOwnerFixture(); t.after(f.close);
    let finalEdge = false, withdrawn = false;
    f.controls.beforeEdge = () => { finalEdge = true; };
    Object.assign(f.ports.authority, { current: (q: { operation: string }) => !(withdrawn && q.operation === operation) });
    Object.assign(f.ports.history, { allowsHistoryRead: async () => { if (finalEdge) withdrawn = true; return true; } });
    const owner = value(f.make()), result = await owner.launchOnce(f.binding, new AbortController().signal);
    assert.ok(!result.ok || result.value.kind === "unknown");
    assert.equal(withdrawn, true); assert.equal(f.calls.length, 0); assert.equal(f.posts, 1); assert.equal(f.held.size, 1);
  });

test("optional parent guard can restrict but cannot grant an independently denied launch", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close); f.deny("approveLaunch");
  assert.equal((await f.owner.launchOnce(f.binding, new AbortController().signal, () => true)).ok, false);
  assert.equal(f.calls.length, 0); assert.equal(f.posts, 0);
});
