import assert from "node:assert/strict";
import test from "node:test";
import { outboundTargetedLaunchFixture } from "../support/outbound-targeted-launch.ts";
import { outboundLaunchOwnerFixture } from "../support/outbound-launch-owner.ts";
import { value } from "../support/outbound-records.ts";
import { ClinikoOutboundLaunchOwner } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";

test("explicit sick-day composition observes only the original target and sends no clinical context to the provider", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close);
  assert.deepEqual(value(await f.launchTargeted()), { kind: "accepted", capacity: "held" }); assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0]!).sort(), ["capacityAllocationRef", "effectRef", "number", "profileRef"]);
  assert.ok(f.targetState.gets >= 8); assert.ok(f.targetLaunchQueries.some(q => q.operation === "approveAppointmentTarget" && q.target?.digest === f.observed.digest));
  assert.ok(f.targetQueries.some(q => q.request?.purpose === "sickDay" && q.targetDigest === f.observed.digest));
  assert.equal(f.targetLaunchQueries.some(q => JSON.stringify(q).includes("discard-private-native-target-note")), false);
});
test("no target configuration can be inferred and the old untargeted owner still refuses sick-day", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close);
  assert.equal((await f.launch()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0);
  assert.equal(ClinikoOutboundLaunchOwner.create(f.targetConfig, { ...f.targetPorts, target: undefined } as unknown as typeof f.targetPorts).ok, false);
});
test("general follow-up keeps the original grant surface without appointment reads", async t => {
  const f = await outboundLaunchOwnerFixture(); t.after(f.close); assert.equal(value(await f.launch()).kind, "accepted"); assert.equal(f.calls.length, 1);
});
for (const stage of ["raw", "decoded", "current", "launch"] as const)
  test(`independent appointment permission refuses ${stage}`, async t => {
    const f = await outboundTargetedLaunchFixture(); t.after(f.close);
    if (stage === "raw") f.targetState.allowed = false;
    if (stage === "decoded") f.targetState.allows = q => !q.target;
    if (stage === "current") f.targetState.live = false;
    if (stage === "launch") f.deny("approveAppointmentTarget");
    assert.equal((await f.launchTargeted()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0);
  });
for (const [name, patch] of Object.entries({ versionPrecision: { updated_at: "2026-10-02T00:00:00.000002Z" },
  practitioner: { practitioner: { links: { self: "https://api.au5.cliniko.com/v1/practitioners/32" } } },
  cancelled: { cancelled_at: "2026-11-02T00:00:00.000Z" }, rescheduled: { starts_at: "2026-11-03T11:00:00.000001+11:00" },
  wrongPatient: { patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/22" } } } }))
  test(`a changed original target before the final provider fence cannot launch: ${name}`, async t => {
    const f = await outboundTargetedLaunchFixture(); t.after(f.close); f.controls.beforeEdge = () => { Object.assign(f.targetRow, patch); };
    const result = await f.launchTargeted(); assert.equal(result.ok && result.value.kind === "accepted", false); assert.equal(f.calls.length, 0);
    assert.equal(f.posts, 1); assert.equal((await f.launchTargeted()).ok, false);
  });
test("a target change during its independent launch grant is reread before consuming effects", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close);
  f.targetState.launchAllows = q => { if (q.operation === "approveAppointmentTarget") f.targetRow.updated_at = "2026-10-02T00:00:00.000002Z"; return true; };
  assert.equal((await f.launchTargeted()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0); assert.equal(f.burned.size, 0);
});
for (const [name, patch] of Object.entries({ cancelled: { cancelled_at: "2026-11-02T00:00:00.000Z" }, archived: { archived_at: "2026-11-02T00:00:00.000Z" },
  deleted: { deleted_at: "2026-11-02T00:00:00.000Z" }, arrived: { patient_arrived: true }, missed: { did_not_arrive: true },
  started: { starts_at: "2026-11-02T00:00:00.000Z" } }))
  test(`a newly pinned but ineligible native appointment still refuses sick-day: ${name}`, async t => {
    const f = await outboundTargetedLaunchFixture(); t.after(f.close); Object.assign(f.targetRow, patch);
    const { ClinikoOutboundAppointmentTarget } = await import("../../src/cliniko/outbound-appointment-target.ts");
    const reader = value(ClinikoOutboundAppointmentTarget.create({ requests: f.config.requests, appointmentPolicyDigest: "9".repeat(64) }, f.targetPorts.target, f.targetPorts.native));
    const observed = value(await reader.observeTarget({ patientId: f.request.patientId, appointmentRef: f.observed.target.appointmentRef }, new AbortController().signal));
    Object.assign(f.request, { appointment: { ref: observed.target.appointmentRef, digest: observed.digest } }); f.requestRow.notes = value(encodeOutboundRecipientRequest(f.request));
    assert.equal((await f.launchTargeted()).ok, false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0);
  });
test("target authority methods are pinned and cannot be replaced to reverse denial", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close); f.targetState.allowed = false;
  Object.assign(f.targetPorts.target, { allows: async () => true });
  assert.equal((await f.launchTargeted()).ok, false); assert.equal(f.calls.length, 0);
});
test("exact acknowledgement survives later target-permission withdrawal", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close); f.controls.afterAck = () => { f.targetState.live = false; };
  assert.equal(value(await f.launchTargeted()).kind, "accepted"); assert.equal(f.calls.length, 1); assert.equal(f.held.size, 1);
});

test("independent target grant withdrawal at the last provider edge refuses with retained possible-attempt evidence", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close); f.controls.beforeEdge = () => { f.targetState.live = false; };
  const result = await f.launchTargeted(); assert.equal(result.ok && result.value.kind === "accepted", false); assert.equal(f.calls.length, 0); assert.equal(f.posts, 1); assert.equal(f.held.size, 1);
});
test("concurrent targeted owners cannot acquire two call places or queue two calls", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close);
  const a = value(f.makeTargeted()), b = value(f.makeTargeted()), signal = new AbortController().signal;
  const results = await Promise.all([a.launchOnce(f.binding, signal), b.launchOnce(f.binding, signal)]);
  assert.equal(results.filter(r => r.ok && r.value.kind === "accepted").length, 1); assert.equal(f.calls.length, 1); assert.equal(f.posts, 1); assert.equal(f.held.size, 1);
});
test("a caller can neither change the pinned target policy nor replace its captured grant", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close); f.targetConfig.individualTarget.appointmentPolicyDigest = "a".repeat(64);
  assert.equal(value(await f.launchTargeted()).kind, "accepted");
  assert.ok(f.targetQueries.every(q => q.appointmentPolicyDigest === "9".repeat(64)));
});
test("aborted targeted launch reads no appointment and consumes no new action", async t => {
  const f = await outboundTargetedLaunchFixture(); t.after(f.close); const controller = new AbortController(); controller.abort();
  assert.equal((await f.launchTargeted(controller.signal)).ok, false); assert.equal(f.targetState.gets, 0); assert.equal(f.calls.length, 0); assert.equal(f.burned.size, 0);
});
