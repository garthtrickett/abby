import assert from "node:assert/strict";
import test from "node:test";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { now, setup, success } from "./fixture.ts";

const afterDelay = "2026-09-28T10:01:01.000Z";
const later = "2026-09-28T10:01:02.000Z";

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
