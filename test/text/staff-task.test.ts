import assert from "node:assert/strict";
import test from "node:test";
import { now, setup } from "./fixture.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import type { StaffItem } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";

for (const resultKind of ["rejected", "uncertain"] as const) {
  test(`TXT-09 ${resultKind} staff task goes to operator review without receipt claim`, async () => {
    const app = await setup(`staff-${resultKind}`);
    await app.turn("handoff", "Please have staff call me", { kind: "handoff", reason: "callerRequested" });
    const item = Object.values((await app.state()).staffItems)[0];
    assert.ok(item);
    app.host.taskResult = task => ({ kind: resultKind, taskKey: task.key });
    await app.worker.process(app.callId, `${item.key}:open`, now);
    assert.equal((await app.state()).staffItems[item.key]?.status, "needsReview");
    assert.deepEqual((await app.state()).staffItems[item.key]?.destination, app.policy.operatorQueue);
    assert.equal((await app.state()).staffItems[item.key]?.hostTaskRef, undefined);
    assert.equal((await app.state()).callerMessages.some(message => message.includes("staff received")), false);
    assert.equal(app.host.tasks.length, 1);
  });
}

test("TXT-09 staff transport failure remains in operator review", async () => {
  const app = await setup("staff-transport");
  await app.turn("handoff", "Call me", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  app.host.openTask = async () => { throw new Error("connection lost"); };
  await app.worker.process(app.callId, `${item.key}:open`, now);
  assert.equal((await app.state()).staffItems[item.key]?.status, "needsReview");
  assert.deepEqual((await app.state()).staffItems[item.key]?.destination, app.policy.operatorQueue);
  assert.equal((await app.state()).effects[`${item.key}:open:reconcile`]?.kind, "staffReconcile");
});

test("lost task-open response reconciles the exact host key without creating a second task", async () => {
  const app = await setup("staff-exact-reconcile");
  await app.turn("handoff", "Please call me", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  class LostReceiptHost extends ReferenceClinicHost {
    openCount = 0;
    override async openTask(task: StaffItem) {
      this.openCount += 1;
      const receipt = await super.openTask(task);
      if (this.openCount === 1) throw new Error("response lost after commit");
      return receipt;
    }
  }
  const host = new LostReceiptHost([], []);
  const worker = new EffectWorker(app.runtime, host);
  await worker.process(app.callId, `${item.key}:open`, now);
  const uncertain = await app.state();
  assert.equal(uncertain.staffItems[item.key]?.status, "needsReview");
  assert.equal(uncertain.effects[`${item.key}:open:reconcile`]?.status, "pending");
  await worker.process(app.callId, `${item.key}:open:reconcile`, now);
  const recovered = await app.state();
  assert.equal(recovered.staffItems[item.key]?.status, "open");
  assert.equal(recovered.staffItems[item.key]?.hostTaskRef, `reference-task:${item.key}`);
  assert.deepEqual(recovered.staffItems[item.key]?.destination, app.policy.staffDestination);
  assert.equal(recovered.effects[`${item.key}:open:reconcile`]?.status, "completed");
  assert.equal(host.openCount, 1);
  assert.equal(host.tasks(app.scope).length, 1);
});

test("crash after possible task send reconciles the original key without replay", async () => {
  const app = await setup("staff-crash-reconcile");
  await app.turn("handoff", "Please call me", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const host = new ReferenceClinicHost([], []);
  assert.equal((await host.openTask(item)).kind, "opened");
  const effectId = `${item.key}:open`;
  assert.equal((await app.runtime.markStaffPossiblySent(app.callId, effectId, now)).ok, true);
  assert.equal((await app.runtime.recoverStaffPossiblySent(app.callId, effectId, "2026-09-28T10:01:01.000Z")).ok, true);
  const worker = new EffectWorker(app.runtime, host);
  await worker.process(app.callId, `${effectId}:reconcile`, now);
  assert.equal((await app.state()).staffItems[item.key]?.status, "open");
  assert.equal(host.tasks(app.scope).length, 1);
  assert.equal((await app.state()).effects[effectId]?.status, "completed");
});

test("unknown or mismatched task reconciliation stays visible for operator review", async () => {
  for (const outcome of ["stillUnknown", "definitiveNonOpen", "wrongDestination"] as const) {
    const app = await setup(`staff-observation-${outcome}`);
    await app.turn("handoff", "Please call me", { kind: "handoff", reason: "callerRequested" });
    const item = Object.values((await app.state()).staffItems)[0];
    assert.ok(item);
    app.host.taskResult = task => ({ kind: "uncertain", taskKey: task.key });
    await app.worker.process(app.callId, `${item.key}:open`, now);
    app.host.taskObservation = task => outcome === "wrongDestination"
      ? { kind: "exactOpen", taskKey: task.key, hostTaskRef: "foreign-task", destination: app.policy.operatorQueue }
      : { kind: outcome, taskKey: task.key };
    if (outcome === "wrongDestination") {
      await assert.rejects(app.worker.process(app.callId, `${item.key}:open:reconcile`, now));
      assert.equal((await app.state()).effects[`${item.key}:open:reconcile`]?.status, "pending");
    } else {
      await app.worker.process(app.callId, `${item.key}:open:reconcile`, now);
      assert.equal((await app.state()).effects[`${item.key}:open:reconcile`]?.status, "completed");
    }
    assert.equal((await app.state()).staffItems[item.key]?.status, "needsReview");
    assert.deepEqual((await app.state()).staffItems[item.key]?.destination, app.policy.operatorQueue);
    assert.equal((await app.state()).staffItems[item.key]?.hostTaskRef, undefined);
  }
});

test("invalid opened staff receipts cannot claim a saved request or authorize replay", async () => {
  for (const fault of ["emptyRef", "wrongDestination"] as const) {
    const app = await setup(`staff-invalid-open-${fault}`);
    await app.turn("handoff", "Please have staff call me", { kind: "handoff", reason: "callerRequested" });
    const item = Object.values((await app.state()).staffItems)[0]!;
    app.host.taskResult = task => ({ kind: "opened", taskKey: task.key,
      hostTaskRef: fault === "emptyRef" ? "" : "possible-foreign-task",
      destination: fault === "wrongDestination" ? app.policy.operatorQueue : task.destination });
    await app.worker.process(app.callId, `${item.key}:open`, now);
    const state = await app.state();
    assert.equal(state.effects[`${item.key}:open`]?.status, "uncertain");
    assert.equal(state.staffItems[item.key]?.hostTaskRef, undefined);
    assert.match(state.callerMessages.at(-1)!, /can't confirm whether.*staff request.*won't send.*again/);
    assert.equal(app.host.tasks.length, 1);
  }
});
