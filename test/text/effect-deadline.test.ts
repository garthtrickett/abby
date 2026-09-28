import assert from "node:assert/strict";
import test from "node:test";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import { EffectWorkLoop } from "../../src/core/effect-work-loop.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import type { HostMutation, HostWriteReceipt, ReconcileObservation, StaffItem, StaffTaskReceipt } from "../../src/core/model.ts";
import { FakeHost, now, setup, success } from "./fixture.ts";

const deadlineMs = 10;

test("text E2E: timed-out booking write becomes uncertain and a late response cannot confirm it", async () => {
  const app = await setup("deadline-booking");
  await app.turn("book", "Book physio", { kind: "requestAction", request: app.book() });
  const action = await app.pendingAction();
  await app.confirm(action.key);

  let lateReply: ((receipt: HostWriteReceipt) => void) | undefined;
  let writeSignal: AbortSignal | undefined;
  class DelayedWriteHost extends FakeHost {
    override async write(mutation: HostMutation, _now: string, signal?: AbortSignal): Promise<HostWriteReceipt> {
      this.writes.push(mutation);
      writeSignal = signal;
      return new Promise(resolve => { lateReply = resolve; });
    }
  }
  const host = new DelayedWriteHost();
  const effectId = `${action.key}:write`;
  await new EffectWorker(app.runtime, host, undefined, undefined, { hostDeadlineMs: deadlineMs })
    .process(app.callId, effectId, now);
  let state = await app.state();
  assert.equal(state.actions[action.key]?.status, "uncertain");
  assert.equal(state.effects[effectId]?.status, "uncertain");
  assert.equal(state.effects[`${effectId}:reconcile`]?.status, "pending");
  assert.equal(host.writes.length, 1);
  assert.equal(writeSignal?.aborted, true);

  assert.ok(lateReply);
  lateReply({ kind: "committed", actionKey: action.key, hostRef: "late-host-booking" });
  await Promise.resolve();
  state = await app.state();
  assert.equal(state.actions[action.key]?.status, "uncertain");

  host.reconcileResult = mutation => ({ kind: "exactCommit", actionKey: mutation.actionKey, hostRef: "late-host-booking" });
  const recovery = new EffectRecovery(app.ledger, () => host, app.scope, undefined, undefined,
    { hostDeadlineMs: deadlineMs });
  assert.equal(success(await recovery.recover(now)).processed, 1);
  assert.equal((await app.state()).actions[action.key]?.status, "committed");
  assert.equal(host.writes.length, 1);
});

test("text E2E: a stalled reconciliation releases the recovery tick and leaves work pending", async () => {
  const app = await setup("deadline-reconcile");
  await app.turn("book", "Book physio", { kind: "requestAction", request: app.book() });
  const action = await app.pendingAction();
  await app.confirm(action.key);
  const effectId = `${action.key}:write`;
  success(await app.runtime.markHostPossiblySent(app.callId, effectId, now));
  success(await app.runtime.recoverHostPossiblySent(app.callId, effectId, "2026-09-28T10:01:01.000Z"));

  class DelayedReconcileHost extends FakeHost {
    stalled = true;
    reconcileSignal: AbortSignal | undefined;
    override async reconcile(mutation: HostMutation, signal?: AbortSignal): Promise<ReconcileObservation> {
      this.reconciliations.push(mutation);
      if (this.stalled) { this.reconcileSignal = signal; return new Promise(() => {}); }
      return { kind: "exactCommit", actionKey: mutation.actionKey, hostRef: "recovered-booking" };
    }
  }
  const host = new DelayedReconcileHost();
  const recovery = new EffectRecovery(app.ledger, () => host, app.scope, undefined, undefined,
    { hostDeadlineMs: deadlineMs });
  const loop = new EffectWorkLoop(recovery, () => {}, { clock: () => "2026-09-28T10:01:02.000Z" });
  const firstResult = await loop.runOnce();
  assert.equal(firstResult.ok, true);
  const first = firstResult.value;
  assert.deepEqual(first.failed, [{ effectId: `${effectId}:reconcile`, kind: "effectFailure" }]);
  assert.equal((await app.state()).effects[`${effectId}:reconcile`]?.status, "pending");
  assert.equal(host.writes.length, 0);
  assert.equal(host.reconcileSignal?.aborted, true);

  host.stalled = false;
  const secondResult = await loop.runOnce();
  assert.equal(secondResult.ok, true);
  const second = secondResult.value;
  assert.equal(second.processed, 1);
  assert.equal((await app.state()).actions[action.key]?.status, "committed");
  assert.equal(host.writes.length, 0);
});

test("text E2E: timed-out staff opening enters exact-key reconciliation without a second open", async () => {
  const app = await setup("deadline-staff");
  await app.turn("handoff", "Please ask staff to call", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);

  class DelayedTaskHost extends FakeHost {
    taskSignal: AbortSignal | undefined;
    override async openTask(value: StaffItem, signal?: AbortSignal): Promise<StaffTaskReceipt> {
      this.tasks.push(value);
      this.taskSignal = signal;
      return new Promise(() => {});
    }
  }
  const host = new DelayedTaskHost();
  const effectId = `${item.key}:open`;
  await new EffectWorker(app.runtime, host, undefined, undefined, { hostDeadlineMs: deadlineMs })
    .process(app.callId, effectId, now);
  const state = await app.state();
  assert.equal(state.staffItems[item.key]?.status, "needsReview");
  assert.equal(state.effects[effectId]?.status, "uncertain");
  assert.equal(state.effects[`${effectId}:reconcile`]?.status, "pending");
  assert.equal(host.tasks.length, 1);
  assert.equal(host.taskSignal?.aborted, true);
});
