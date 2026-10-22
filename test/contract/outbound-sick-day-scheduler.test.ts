import assert from "node:assert/strict";
import test from "node:test";
import { outboundSchedulerFixture } from "../support/outbound-scheduler.ts";
import { ClinikoOutboundScheduler } from "../../src/standalone/cliniko-outbound-scheduler.ts";

test("finite sick-day scheduler launches only its independently approved exact original appointment", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close);
  assert.deepEqual(await f.tick(), { kind: "observed", considered: 1, accepted: 1, unknown: 0, refused: 0, alreadyAttempted: 0 });
  assert.ok(f.targetedLaunch); assert.ok(f.targetedLaunch.targetState.gets >= 8);
  assert.ok(f.targetedLaunch.targetLaunchQueries.some(q => q.operation === "approveAppointmentTarget" && q.target?.digest === f.targetedLaunch!.observed.digest));
  assert.equal(f.calls.length, 1); assert.equal(f.posts, 1); assert.ok(f.claims <= 180);
  assert.deepEqual(Object.keys(f.calls[0]!).sort(), ["capacityAllocationRef", "effectRef", "number", "profileRef"]);
});

test("sick-day scheduling cannot infer missing exact-target configuration or load its audience", async t => {
  const f = await outboundSchedulerFixture({ purpose: "sickDay", appointment: { ref: "cliniko:appointment:71", digest: "a".repeat(64) } }); t.after(f.close);
  assert.equal((await f.tick()).kind, "blocked"); assert.equal(f.scheduleState.accountReads, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.posts, 0); assert.equal(f.burned.size, 0);
});

test("sick-day scheduler requires the independently configured appointment authority", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close);
  const { target: _target, ...launch } = f.schedulerPorts.launch;
  assert.equal(ClinikoOutboundScheduler.create(f.schedulerConfig, { ...f.schedulerPorts, launch }).ok, false);
  assert.equal(f.scheduleState.accountReads, 0); assert.equal(f.calls.length, 0);
});

for (const stage of ["raw", "decoded", "current", "launch"] as const)
test(`sick-day scheduling preserves independent ${stage} appointment permission`, async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close); assert.ok(f.targetedLaunch);
  if (stage === "raw") f.targetedLaunch.targetState.allowed = false;
  if (stage === "decoded") f.targetedLaunch.targetState.allows = q => !q.target;
  if (stage === "current") f.targetedLaunch.targetState.live = false;
  if (stage === "launch") f.deny("approveAppointmentTarget");
  const result = await f.tick(); assert.equal(result.accepted, 0); assert.equal(result.refused, 1);
  assert.equal(f.calls.length, 0); assert.equal(f.posts, 0); assert.equal(f.burned.size, 0);
});

test("changed exact appointment during pending audience discovery cannot consume a launch", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close); assert.ok(f.targetedLaunch);
  f.scheduleState.onAccount = () => { f.targetedLaunch!.targetRow.updated_at = "2026-10-02T00:00:00.000002Z"; };
  assert.equal((await f.tick()).accepted, 0); assert.equal(f.posts, 0); assert.equal(f.calls.length, 0); assert.equal(f.burned.size, 0);
});

test("exact appointment withdrawal at the provider edge retains possible evidence without dispatch", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close); assert.ok(f.targetedLaunch);
  f.controls.beforeEdge = () => { f.targetedLaunch!.targetState.live = false; };
  assert.equal((await f.tick()).accepted, 0); assert.equal(f.calls.length, 0); assert.equal(f.posts, 1); assert.equal(f.held.size, 1);
});

test("sick-day target is rechecked after a real physical headroom refusal and bounded wait", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close); assert.ok(f.targetedLaunch);
  for (let n = 0; n < 100; n++) assert.equal(f.budget.claim(), null);
  f.scheduleState.beforeWait = () => { f.targetedLaunch!.targetRow.cancelled_at = f.state.now; };
  assert.equal((await f.tick()).accepted, 0); assert.equal(f.scheduleState.waits, 1);
  assert.equal(f.posts, 0); assert.equal(f.calls.length, 0); assert.equal(f.burned.size, 0);
});

for (const boundary of ["quiet", "before", "expired"] as const)
test(`sick-day ${boundary} campaign cannot load a private audience`, async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close);
  f.state.now = boundary === "quiet" ? "2026-11-02T08:00:00.000Z" : boundary === "before" ? "2026-11-01T00:00:00.000Z" : "2026-11-10T00:00:00.000Z";
  assert.equal((await f.tick()).accepted, 0); assert.equal(f.scheduleState.accountReads, 0); assert.equal(f.calls.length, 0);
});

test("cancelled sick-day campaign cannot load an audience", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close); await f.cancelCampaign();
  assert.equal((await f.tick()).kind, "idle"); assert.equal(f.scheduleState.accountReads, 0); assert.equal(f.calls.length, 0);
});

test("unknown sick-day dispatch stays consumed across a cold finite tick", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close); f.controls.mode = "unknown";
  assert.equal((await f.tick()).unknown, 1); assert.equal(f.calls.length, 1);
  f.state.now = new Date(Date.parse(f.state.now) + 60_000).toISOString();
  const result = await f.makeScheduler().tick(new AbortController().signal);
  assert.equal(result.accepted, 0); assert.equal(result.alreadyAttempted, 1); assert.equal(f.calls.length, 1); assert.equal(f.posts, 1);
});

test("known sick-day launch acknowledgement survives immediate outer cancellation", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close); const controller = new AbortController();
  f.controls.mode = "loseAfterAck"; f.controls.afterAck = () => { controller.abort(); };
  const result = await f.tick(controller.signal);
  assert.equal(result.kind, "interrupted"); assert.equal(result.accepted, 1); assert.equal(f.calls.length, 1);
});

test("concurrent sick-day ticks share actual one-use capacity and expose no private target summary", async t => {
  const f = await outboundSchedulerFixture({ exactSickDay: true }); t.after(f.close); assert.ok(f.targetedLaunch);
  const results = await Promise.all([f.tick(), f.makeScheduler().tick(new AbortController().signal)]);
  assert.equal(results.reduce((n, r) => n + r.accepted, 0), 1); assert.equal(f.calls.length, 1); assert.equal(f.posts, 1);
  const text = JSON.stringify(results);
  for (const secret of [f.request.patientId, f.request.recipient.number, f.request.actionRef, f.request.effectRef,
    f.targetedLaunch.observed.target.appointmentRef, f.targetedLaunch.observed.digest]) assert.equal(text.includes(secret), false);
});
