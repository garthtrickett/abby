import assert from "node:assert/strict";
import test from "node:test";
import { outboundSchedulerFixture } from "../support/outbound-scheduler.ts";

test("finite scheduler composes actual policy, native pending reads, contact/history and one dispatch", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close);
  assert.deepEqual(await f.tick(), { kind: "observed", considered: 1, accepted: 1, unknown: 0, refused: 0, alreadyAttempted: 0 });
  assert.equal(f.calls.length, 1); assert.equal(f.posts, 1); assert.equal(f.scheduleState.accountReads, 1); assert.ok(f.claims <= 180);
  f.state.now = new Date(Date.parse(f.state.now) + 60_000).toISOString();
  const cold = await f.makeScheduler().tick(new AbortController().signal);
  assert.equal(cold.accepted, 0); assert.equal(cold.alreadyAttempted, 1); assert.equal(f.calls.length, 1);
  const text = JSON.stringify(cold);
  for (const privateValue of [f.request.patientId, f.request.recipient.number, f.request.effectRef, f.request.actionRef]) assert.equal(text.includes(privateValue), false);
});
for (const role of ["schedule", "pending", "record"] as const)
  test(`independent ${role} denial prevents any provider attempt`, async t => {
    const f = await outboundSchedulerFixture(); t.after(f.close); f.scheduleState[role] = false;
    assert.equal((await f.tick()).kind, "blocked"); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0);
    if (role === "schedule") assert.equal(f.scheduleState.accountReads, 0);
  });
test("withdrawn scheduling during native account read returns no private audience or launch", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close); f.scheduleState.onAccount = () => { f.scheduleState.schedule = false; };
  assert.equal((await f.tick()).kind, "blocked"); assert.equal(f.calls.length, 0); assert.equal(f.posts, 0);
});
for (const boundary of ["quiet", "before", "expired"] as const)
  test(`${boundary} campaign does not load a private audience`, async t => {
    const f = await outboundSchedulerFixture(); t.after(f.close);
    f.state.now = boundary === "quiet" ? "2026-11-02T08:00:00.000Z" : boundary === "before" ? "2026-11-01T00:00:00.000Z" : "2026-11-10T00:00:00.000Z";
    const result = await f.tick(); assert.equal(result.accepted, 0); assert.equal(f.scheduleState.accountReads, 0); assert.equal(f.calls.length, 0);
  });
test("cancelled campaign does not load an audience", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close); await f.cancelCampaign();
  assert.equal((await f.tick()).kind, "idle"); assert.equal(f.scheduleState.accountReads, 0); assert.equal(f.calls.length, 0);
});
test("current scheduling withdrawal at provider edge cannot launch", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close);
  f.controls.beforeEdge = () => { f.scheduleState.schedule = false; };
  const result = await f.tick(); assert.equal(result.accepted, 0); assert.equal(f.calls.length, 0); assert.equal(f.posts, 1);
});
test("only pre-dispatch headroom denial waits, then actual native180 and all launch gates are checked", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close);
  for (let n = 0; n < 100; n++) assert.equal(f.budget.claim(), null);
  assert.equal((await f.tick()).accepted, 1); assert.equal(f.scheduleState.waits, 1); assert.equal(f.calls.length, 1); assert.equal(f.posts, 1);
});
for (const change of ["schedule", "campaign", "contact", "quiet"] as const)
  test(`${change} change during quota wait cannot dispatch`, async t => {
    const f = await outboundSchedulerFixture(); t.after(f.close);
    for (let n = 0; n < 100; n++) assert.equal(f.budget.claim(), null);
    f.scheduleState.beforeWait = async () => {
      if (change === "schedule") f.scheduleState.schedule = false;
      if (change === "campaign") await f.cancelCampaign();
      if (change === "contact") f.state.live = false;
      if (change === "quiet") f.state.now = "2026-11-02T08:00:00.000Z";
    };
    assert.equal((await f.tick()).accepted, 0); assert.equal(f.scheduleState.waits, 1); assert.equal(f.calls.length, 0);
  });
test("insufficient first-stage physical budget never loads an audience", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close);
  for (let n = 0; n < 150; n++) assert.equal(f.budget.claim(), null);
  assert.equal((await f.tick()).kind, "quotaWaiting"); assert.equal(f.scheduleState.accountReads, 0); assert.equal(f.calls.length, 0);
});
test("capacity remains occupied across requests and only one call is launched", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close); const next = f.addRequest("22");
  const result = await f.tick(); assert.equal(result.kind, "capacityWaiting"); assert.equal(result.accepted, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.posts, 1); assert.equal(f.burned.has(next.effectRef), false);
});
test("unknown call remains consumed and is never retried by a cold tick", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close); f.controls.mode = "unknown";
  assert.equal((await f.tick()).unknown, 1); assert.equal(f.calls.length, 1);
  f.state.now = new Date(Date.parse(f.state.now) + 60_000).toISOString();
  assert.equal((await f.makeScheduler().tick(new AbortController().signal)).unknown, 0); assert.equal(f.calls.length, 1);
});
test("known accepted launch survives immediate outer abort and later observation loss", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close); const controller = new AbortController();
  f.controls.mode = "loseAfterAck"; f.controls.afterAck = () => { controller.abort(); };
  const result = await f.tick(controller.signal); assert.equal(result.kind, "interrupted"); assert.equal(result.accepted, 1); assert.equal(f.calls.length, 1);
});
test("captured scheduling authority cannot be replaced after factory construction", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close); f.scheduleState.schedule = false;
  Object.assign(f.schedulerPorts.schedule, { current: () => true, allows: async () => true });
  assert.equal((await f.tick()).kind, "blocked"); assert.equal(f.calls.length, 0);
});
test("concurrent independent ticks use actual one-use exclusions, not a private running flag", async t => {
  const f = await outboundSchedulerFixture(); t.after(f.close);
  const results = await Promise.all([f.tick(), f.makeScheduler().tick(new AbortController().signal)]);
  assert.equal(results.reduce((n, r) => n + r.accepted, 0), 1); assert.equal(f.calls.length, 1); assert.equal(f.posts, 1);
});
