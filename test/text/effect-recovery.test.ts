import assert from "node:assert/strict";
import test from "node:test";
import { EffectCallLeaseCoordinator } from "../../src/core/effect-call-lease.ts";
import type { EffectCallLeaseStore } from "../../src/core/effect-call-lease.ts";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { Result } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import type { TimerPort } from "../../src/core/timer.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { now, setup, success } from "./fixture.ts";

const afterDelay = "2026-09-28T10:01:01.000Z";
const later = "2026-09-28T10:01:02.000Z";

function value<T>(result: Result<T, { kind: string }>): T {
  assert.equal(result.ok, true, result.ok ? "" : result.error.kind);
  return result.value;
}

test("recovery scans pending host work and leaves another tenant untouched", async () => {
  const app = await setup("recover-pending-task");
  await app.turn("handoff", "Ask staff to call", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const foreign = new EffectRecovery(app.ledger, () => app.host, { ...app.scope, tenantId: "foreign" });
  assert.equal(success(await foreign.recover(now)).scanned, 0);
  assert.equal((await app.state()).staffItems[item.key]?.status, "requested");
  const recovery = new EffectRecovery(app.ledger, () => app.host, app.scope);
  const first = success(await recovery.recover(now));
  assert.deepEqual({ scanned: first.scanned, processed: first.processed, recovered: first.recovered, failed: first.failed.length },
    { scanned: 1, processed: 1, recovered: 0, failed: 0 });
  assert.equal((await app.state()).staffItems[item.key]?.status, "open");
  assert.equal(app.host.tasks.length, 1);
  assert.equal(success(await recovery.recover(now)).processed, 0);
});

test("two recovery workers cannot open the same call's task concurrently", async () => {
  const app = await setup("recover-concurrent-call");
  await app.turn("handoff", "Ask staff to call", { kind: "handoff", reason: "callerRequested" });
  let started!: () => void;
  let release!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  app.host.openTask = async item => {
    sends += 1;
    started();
    await hold;
    return { kind: "opened", taskKey: item.key, hostTaskRef: "single-task", destination: item.destination };
  };
  const first = new EffectRecovery(app.ledger, () => app.host, app.scope).recover(now);
  await opening;
  try {
    const second = success(await new EffectRecovery(app.ledger, () => app.host, app.scope).recover(afterDelay));
    assert.deepEqual({ scanned: second.scanned, deferred: second.deferred, failed: second.failed },
      { scanned: 1, deferred: 1, failed: [] });
    assert.equal(sends, 1);
  } finally { release(); }
  assert.equal(success(await first).processed, 1);
  assert.equal((await app.state()).staffItems[Object.keys((await app.state()).staffItems)[0]!]!.status, "open");
  assert.equal(sends, 1);
});

for (const firstOwner of ["foreground", "recovery"] as const) {
  test(`${firstOwner} effect dispatch holds the call lease against the other path`, async () => {
    const app = await setup(`recover-cross-path-${firstOwner}`);
    await app.turn("handoff", "Ask staff to call", { kind: "handoff", reason: "callerRequested" });
    const host = new ReferenceClinicHost([], []);
    const originalOpen = host.openTask.bind(host);
    let entered!: () => void;
    let release!: () => void;
    const opening = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    let sends = 0;
    host.openTask = async item => {
      sends += 1;
      entered();
      await hold;
      return originalOpen(item);
    };
    const reception = new TextReception(app.ledger, new MemoryPolicyStore(), host);
    const recovery = new EffectRecovery(app.ledger, () => host, app.scope);
    const first = firstOwner === "foreground"
      ? reception.drain(app.scope, app.callId, now) : recovery.recover(now);
    await opening;
    try {
      if (firstOwner === "foreground") {
        const second = success(await recovery.recover(afterDelay));
        assert.deepEqual([second.scanned, second.deferred, second.failed.length], [1, 1, 0]);
      } else {
        const second = value(await reception.drain(app.scope, app.callId, afterDelay));
        assert.equal(Object.values(second.staffItems)[0]?.status, "requested");
      }
      assert.equal(sends, 1);
    } finally { release(); }
    const completed = await first;
    assert.equal(completed.ok, true);
    assert.equal(Object.values((await app.state()).staffItems)[0]?.status, "open");
    assert.equal(sends, 1);
  });
}

test("an immediate staff change holds the same call lease as recovery", async () => {
  const app = await setup("recover-staff-change-cross-path");
  await app.turn("handoff", "Ask staff to call", { kind: "handoff", reason: "callerRequested" });
  const host = new ReferenceClinicHost([], []);
  const reception = new TextReception(app.ledger, new MemoryPolicyStore(), host);
  value(await reception.drain(app.scope, app.callId, now));
  const before = await app.state();
  const task = Object.values(before.staffItems)[0];
  assert.ok(task);
  let entered!: () => void;
  let release!: () => void;
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const originalAdvance = host.advanceTask.bind(host);
  let sends = 0;
  host.advanceTask = async change => {
    sends += 1;
    entered();
    await hold;
    return originalAdvance(change);
  };
  const changing = reception.changeStaff(app.scope, app.callId, before.version, task.key, "staff-actor", { kind: "resolve" }, now);
  await sending;
  try {
    const competing = success(await new EffectRecovery(app.ledger, () => host, app.scope).recover(afterDelay));
    assert.deepEqual([competing.scanned, competing.deferred, competing.failed.length], [1, 1, 0]);
    assert.equal(sends, 1);
  } finally { release(); }
  assert.equal(value(await changing).staffItems[task.key]?.status, "resolved");
  assert.equal(sends, 1);
});

test("expired call leases can be reclaimed and stale owners cannot affect the new owner", async () => {
  const app = await setup("recover-lease-expiry");
  const first = "worker-one";
  const second = "worker-two";
  assert.equal(success(await app.ledger.claimEffectCall(app.callId, app.scope, first, 60_000, now)), true);
  assert.equal(success(await app.ledger.claimEffectCall(app.callId, app.scope, second, 60_000, now)), false);
  assert.equal(success(await app.ledger.renewEffectCall(app.callId, app.scope, first, 60_000, "2026-09-28T10:00:30.000Z")), true);
  assert.equal(success(await app.ledger.claimEffectCall(app.callId, app.scope, second, 60_000, "2026-09-28T10:01:00.000Z")), false);
  assert.equal(success(await app.ledger.claimEffectCall(app.callId, app.scope, second, 60_000, "2026-09-28T10:01:31.000Z")), true);
  assert.equal(success(await app.ledger.renewEffectCall(app.callId, app.scope, first, 60_000, "2026-09-28T10:01:32.000Z")), false);
  assert.equal(success(await app.ledger.releaseEffectCall(app.callId, app.scope, first)), false);
  assert.equal(success(await app.ledger.claimEffectCall(app.callId, app.scope, first, 60_000, "2026-09-28T10:01:32.000Z")), false);
  assert.equal(success(await app.ledger.releaseEffectCall(app.callId, app.scope, second)), true);
});

test("a running recovery renews its lease until work completes", async () => {
  const app = await setup("recover-lease-renewal");
  const callbacks = new Map<number, () => void>();
  let nextHandle = 0;
  const timer: TimerPort = {
    schedule(callback) { const handle = ++nextHandle; callbacks.set(handle, callback); return handle; },
    cancel(handle) { callbacks.delete(handle as number); },
  };
  let currentTime = now;
  let entered!: () => void;
  let release!: () => void;
  let renewed!: () => void;
  const workStarted = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const renewalSeen = new Promise<void>(resolve => { renewed = resolve; });
  const store: EffectCallLeaseStore = {
    claimEffectCall: (...args) => app.ledger.claimEffectCall(...args),
    renewEffectCall: async (...args) => {
      const result = await app.ledger.renewEffectCall(...args);
      renewed();
      return result;
    },
    releaseEffectCall: (...args) => app.ledger.releaseEffectCall(...args),
  };
  const coordinator = new EffectCallLeaseCoordinator(store, { timer, clock: () => currentTime });
  const active = coordinator.run(app.callId, app.scope, async signal => {
    assert.equal(signal.aborted, false);
    entered();
    await hold;
    return "done";
  });
  await workStarted;
  try {
    currentTime = "2026-09-28T10:00:15.000Z";
    assert.equal(callbacks.size, 1);
    const [handle, callback] = callbacks.entries().next().value!;
    callbacks.delete(handle);
    callback();
    await renewalSeen;
    assert.equal(success(await app.ledger.claimEffectCall(app.callId, app.scope, "other-worker", 60_000,
      "2026-09-28T10:01:00.000Z")), false);
  } finally { release(); }
  assert.deepEqual(success(await active), { kind: "completed", value: "done" });
  assert.equal(callbacks.size, 0);
  assert.equal(success(await app.ledger.claimEffectCall(app.callId, app.scope, "other-worker", 60_000,
    "2026-09-28T10:01:00.000Z")), true);
});

test("recovery never retries a possibly sent booking write and reconciles its original key", async () => {
  const app = await setup("recover-booking-write");
  await app.turn("book", "Book physio", { kind: "requestAction", request: app.book() });
  const action = await app.pendingAction();
  await app.confirm(action.key);
  const effectId = `${action.key}:write`;
  success(await app.runtime.markHostPossiblySent(app.callId, effectId, now));
  app.host.reconcileResult = mutation => ({ kind: "exactCommit", actionKey: mutation.actionKey, hostRef: "existing-booking" });
  const recovery = new EffectRecovery(app.ledger, () => app.host, app.scope);
  assert.equal(success(await recovery.recover(now)).scanned, 0);
  assert.equal(success(await recovery.recover(afterDelay)).recovered, 1);
  assert.equal((await app.state()).actions[action.key]?.status, "uncertain");
  assert.equal(success(await recovery.recover(later)).processed, 1);
  assert.equal((await app.state()).actions[action.key]?.status, "committed");
  assert.equal(app.host.writes.length, 0);
  assert.equal(app.host.reconciliations.length, 1);
});

test("recovery proves crashed staff opening and resolution without replaying either mutation", async () => {
  const app = await setup("recover-staff-lifecycle");
  await app.turn("handoff", "Ask staff to call", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const host = new ReferenceClinicHost([], []);
  assert.equal((await host.openTask(item)).kind, "opened");
  const openEffectId = `${item.key}:open`;
  success(await app.runtime.markStaffPossiblySent(app.callId, openEffectId, now));
  const recovery = new EffectRecovery(app.ledger, () => host, app.scope);
  assert.equal(success(await recovery.recover(afterDelay)).recovered, 1);
  assert.equal((await app.state()).staffItems[item.key]?.status, "needsReview");
  assert.equal(success(await recovery.recover(later)).processed, 1);
  assert.equal((await app.state()).staffItems[item.key]?.status, "open");

  const requested = success(await app.runtime.requestStaffChange(app.callId, (await app.state()).version, item.key,
    "staff-actor", { kind: "resolve" }));
  const commandKey = requested.staffItems[item.key]?.pendingChangeKey;
  assert.ok(commandKey);
  const changeEffectId = `${commandKey}:send`;
  const effect = requested.effects[changeEffectId];
  assert.ok(effect && effect.kind === "staffChange");
  success(await app.runtime.markStaffChangePossiblySent(app.callId, changeEffectId, "2026-09-28T10:02:00.000Z"));
  assert.equal((await host.advanceTask(effect.change)).kind, "applied");
  assert.equal(success(await recovery.recover("2026-09-28T10:03:01.000Z")).recovered, 1);
  assert.equal((await app.state()).staffItems[item.key]?.status, "open");
  assert.equal(success(await recovery.recover("2026-09-28T10:03:02.000Z")).processed, 1);
  assert.equal((await app.state()).staffItems[item.key]?.status, "resolved");
  assert.equal(host.tasks(app.scope).length, 1);
  assert.equal(host.tasks(app.scope)[0]?.status, "resolved");
});

test("unavailable host leaves pending work intact and reports the exact effect", async () => {
  const app = await setup("recover-host-unavailable");
  await app.turn("handoff", "Ask staff to call", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const result = success(await new EffectRecovery(app.ledger, () => undefined, app.scope).recover(now));
  assert.deepEqual(result.failed, [{ effectId: `${item.key}:open`, kind: "hostUnavailable" }]);
  assert.equal((await app.state()).effects[`${item.key}:open`]?.status, "pending");
});

test("bounded recovery pages through 101 calls without replaying completed effects", async () => {
  const scope = { tenantId: "recovery-page-tenant", clinicId: "recovery-page-clinic", locationId: "recovery-page-location" };
  const ledger = new MemoryLedger();
  const runtime = new CallRuntime(ledger, scope);
  const host = new ReferenceClinicHost([], []);
  for (let index = 0; index < 101; index += 1) {
    const callId = `recovery-page-${String(index).padStart(3, "0")}`;
    success(await runtime.start(callId, referenceDefaultPolicy(scope)));
    success(await runtime.acceptTurn({ callId, turnId: "handoff", text: "Staff please", quality: "clear", at: now },
      { kind: "handoff", reason: "callerRequested" }, now));
  }
  const recovery = new EffectRecovery(ledger, () => host, scope);
  const first = success(await recovery.recover(now));
  assert.deepEqual([first.scanned, first.processed, first.failed.length], [100, 100, 0]);
  const second = success(await recovery.recover(now));
  assert.deepEqual([second.scanned, second.processed, second.failed.length], [1, 1, 0]);
  assert.equal(host.tasks(scope).length, 101);
  const third = success(await recovery.recover(now));
  assert.equal(third.processed, 0);
  assert.equal(host.tasks(scope).length, 101);
});
