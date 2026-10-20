import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { outboundContactLifecycleFixture } from "../support/outbound-contact-lifecycle.ts";
import { value } from "../support/outbound-records.ts";
import { encodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { ClinikoOutboundLaunchOwner } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
import { ClinikoOutboundTerminalOwner } from "../../src/standalone/cliniko-outbound-terminal-owner.ts";
import { outboundCapacityOwnerBinding, outboundContactGuardOwnerBinding } from "../../src/core/outbound-capacity.ts";

test("composed launch checks complete native number stops and retains independent contact hold/context before one dial", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  assert.deepEqual(value(await f.launch()), { kind: "accepted", capacity: "held" });
  assert.equal(f.calls.length, 1); assert.equal(f.posts, 1); assert.equal(f.held.size, 1); assert.equal(f.contactHeld.size, 1);
  const { row, attempt } = f.retained(); assert.match(String(row.notes), /possible outbound launch v4/);
  assert.equal(attempt.contactReferences?.guardRef, f.guardRef); assert.equal(attempt.contactReferences?.allocationRef, [...f.contactHeld][0]);
  assert.notEqual(attempt.contactReferences?.allocationRef, attempt.capacityAllocationRef);
  assert.ok(f.safetyState.broadReads >= 8 && f.claims <= 180);
  assert.ok(f.numberQueries.some(q => q.operation === "readContactNumberReview" && q.review));
  assert.deepEqual(Object.keys(f.calls[0]!).sort(), ["capacityAllocationRef", "effectRef", "number", "profileRef"]);
});
test("proven terminal call releases normal concurrency but leaves unresolved contact hold across campaigns", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close); value(await f.launch()); const { row, attempt } = f.retained();
  const provider = { ref: attempt.provider.ref, bindingDigest: attempt.provider.bindingDigest };
  const terminal = value(ClinikoOutboundTerminalOwner.create({ attempts: f.config.attempts, campaignRef: f.request.campaignRef, capacityScope: f.request.scope,
    maximumNativeRequests: 10 }, { record: f.ports.attempt, capacity: f.ports.capacity, native: f.native,
    authority: { allows: async () => true, current: () => true }, provider: { binding: () => provider,
      inspectTerminal: async input => ({ kind: "terminal", complete: true, ...input, provider, endedAt: f.state.now, observedAt: f.state.now }) } }));
  assert.deepEqual(value(await terminal.inspectAndRelease({ recallRef: `cliniko:recall:${row.id}`, actionRef: attempt.actionRef, patientId: attempt.patientId }, new AbortController().signal)), { kind: "terminal", released: true });
  assert.equal(f.held.size, 0); assert.equal(f.contactHeld.size, 1);
  const next = await outboundContactLifecycleFixture({ guardRef: f.guardRef, capacity: f.capacity }); t.after(next.close);
  assert.notEqual(next.request.campaignRef, f.request.campaignRef); assert.equal((await next.launch()).ok, false);
  assert.equal(next.calls.length, 0); assert.equal(next.burned.size, 0); assert.equal(f.contactHeld.size, 1);
});
test("an archived other-patient stop at the same number blocks before claims and retention", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  const stop = { ...f.first, actionRef: randomUUID(), approvalRef: randomUUID(), patientId: "22", consent: "unknown" as const, doNotCall: "blocked" as const };
  f.contactControls.rows.push({ ...f.row(stop, "102"), updated_at: f.state.now, archived_at: f.state.now, recalled: true, recalled_at: f.state.now });
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0); assert.equal(f.burned.size, 0); assert.equal(f.contactHeld.size, 0);
  assert.ok(f.numberQueries.some(q => q.operation === "readContactNumberReview" && q.patientId === "22"));
});
test("a new shared-number stop at the final provider fence prevents dispatch and keeps the invoked-adapter holds", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  f.controls.beforeEdge = () => { const stop = { ...f.first, actionRef: randomUUID(), approvalRef: randomUUID(), patientId: "22", consent: "unknown" as const, doNotCall: "blocked" as const };
    f.contactControls.rows.push(f.row(stop, "102")); };
  const answer = await f.launch(); assert.ok(!answer.ok || answer.value.kind === "unknown");
  assert.equal(f.calls.length, 0); assert.equal(f.posts, 1); assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1);
});
test("known pre-invocation retention failure releases both holds but never unburns permanent exclusions", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close); f.controls.retainResponse = () => Response.json({}, { status: 503 });
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.held.size, 0); assert.equal(f.contactHeld.size, 0);
  assert.equal(f.contactReleased.size, 1); assert.ok(f.burned.has(f.request.effectRef)); assert.equal((await f.launch()).ok, false);
});
test("unknown provider outcome retains both holds and stable native contact recovery identities", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close); f.controls.mode = "unknown";
  assert.deepEqual(value(await f.launch()), { kind: "unknown", capacity: "held" });
  assert.equal(f.contactHeld.size, 1); assert.equal(f.held.size, 1); assert.ok(f.retained().attempt.contactReferences?.outcomeActionRef);
  assert.equal((await value(f.make()).launchOnce(f.binding, new AbortController().signal)).ok, false); assert.equal(f.calls.length, 1);
});
for (const denial of ["guard", "broad", "record", "producer"] as const) test(`independent ${denial} denial cannot acquire contact permission`, async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  if (denial === "guard") f.deny("approveContactSafety");
  if (denial === "producer") f.deny("producerAdmitted");
  if (denial === "broad") f.safetyState.allow = q => q.operation !== "readAccountContactHistory";
  if (denial === "record") f.safetyState.allow = q => q.operation !== "readContactNumberReview";
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0); assert.equal(f.burned.size, 0);
});
test("account disablement or stale number-grant permission during native retention cannot reach provider", async t => {
  for (const mode of ["account", "grant"] as const) {
    const f = await outboundContactLifecycleFixture(); try {
      f.controls.retainResponse = async row => { if (mode === "account") await f.replaceAccount({ enabled: false }); else f.safetyState.live = false;
        return Response.json(row, { status: 201 }); };
      assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.contactHeld.size, 0);
    } finally { await f.close(); }
  }
});
test("missing, changed or non-random approved clinic guard cannot be supplied by a campaign", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  assert.equal(ClinikoOutboundLaunchOwner.create({ ...f.config, contactSafety: { ...f.config.contactSafety, guardRef: f.request.campaignRef } }, f.ports).ok, false);
  await f.replaceAccount({ account: { ...f.accountApproval.account, contactGuardRef: randomUUID() } });
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0);
  const { contactSafety: _safety, ...legacy } = f.config; assert.equal(ClinikoOutboundLaunchOwner.create(legacy, f.ports).ok, false);
  assert.notEqual(outboundCapacityOwnerBinding(f.guardRef), outboundContactGuardOwnerBinding(f.guardRef));
  assert.equal(outboundContactGuardOwnerBinding("patient:22"), undefined);
});
test("captured denial cannot be changed by replacing contact port methods after construction", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close); f.safetyState.allow = () => false;
  Object.assign(f.ports.numberStops, { allows: async () => true, current: () => true });
  Object.assign(f.ports.contactCapacity, { matches: () => true });
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0);
});

test("replacing an approved account method cannot bypass captured source coverage", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  Object.assign(f.account, { current: async () => ({ ok: true, value: f.accountApproval }) });
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.contactHeld.size, 0);
});
test("contact source configuration mutation cannot change the captured number-stop role", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  Object.assign(f.config.contact, { contactReviewRecallTypeId: "999", contactPolicyDigest: "f".repeat(64) });
  assert.deepEqual(value(await f.launch()), { kind: "accepted", capacity: "held" });
  assert.ok(f.numberQueries.filter(q => q.operation === "readContactNumberReview").every(q => q.source.contactReviewRecallTypeId === "91"));
});

test("other-patient reconsent expiring after the last number scan cannot authorize final dispatch", async t => {
  const f = await outboundContactLifecycleFixture(); t.after(f.close);
  const other = { ...f.first, actionRef: randomUUID(), approvalRef: randomUUID(), patientId: "22" };
  const stop = f.next(other, { consent: "unknown", doNotCall: "blocked", reviewedAt: f.state.now, effectiveFrom: f.state.now });
  const clear = f.next(stop, { consent: "granted", doNotCall: "clear", reconsentApprovalRef: randomUUID(), reviewedAt: f.state.now, effectiveFrom: f.state.now, effectiveUntil: "2026-11-02T00:00:01.000Z" });
  for (const [index, review] of [other, stop, clear].entries()) f.contactControls.rows.push({ ...f.row(review, String(102 + index)), created_at: review.reviewedAt, updated_at: review.reviewedAt });
  let fence = false, advanced = false;
  f.controls.beforeEdge = () => { fence = true; };
  f.contactControls.get = row => {
    if (fence && String(row.id) === "200") { f.state.now = "2026-11-02T00:00:02.000Z"; advanced = true; }
    return Response.json(row);
  };
  await f.launch(); assert.ok(advanced, "expire the independently cleared head after the final number scan, during later native history");
  assert.equal(f.calls.length, 0); assert.equal(f.contactHeld.size, 1);
});
