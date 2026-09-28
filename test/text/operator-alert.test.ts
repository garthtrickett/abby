import assert from "node:assert/strict";
import test from "node:test";
import { EffectRecovery } from "../../src/core/effect-recovery.ts";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { StaffAlertMonitor } from "../../src/reference/staff-alert-monitor.ts";
import { StaffQueue } from "../../src/reference/staff-queue.ts";
import { now, setup, success } from "./fixture.ts";

const overdueAt = "2026-09-29T10:00:01.000Z";
const afterRecovery = "2026-09-29T10:01:02.000Z";

test("overdue follow-up stages one durable operator alert and delivers through the outbox", async () => {
  const app = await setup("operator-alert-overdue");
  await app.turn("handoff", "Private caller request", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const host = new ReferenceClinicHost([], []);
  const monitor = new StaffAlertMonitor(app.ledger, app.scope);
  assert.equal(success(await monitor.scan(now)), 0);
  assert.equal(success(await monitor.scan(overdueAt)), 1);
  const pending = await app.state();
  assert.equal(pending.effects[`${item.key}:alert:overdue`]?.kind, "operatorAlert");
  assert.equal(pending.staffItems[item.key]?.alerts?.overdue, "pending");
  const recovery = new EffectRecovery(app.ledger, () => host, app.scope);
  const delivered = success(await recovery.recover(overdueAt));
  assert.equal(delivered.failed.length, 0);
  assert.equal(host.alerts(app.scope).length, 1);
  assert.equal(host.alerts(app.scope)[0]?.destination.kind, "queue");
  assert.equal((await app.state()).staffItems[item.key]?.alerts?.overdue, "delivered");
  assert.equal(success(await monitor.scan(overdueAt)), 0);
  success(await recovery.recover(overdueAt));
  assert.equal(host.alerts(app.scope).length, 1);
  const queue = success(await new StaffQueue(app.ledger, () => overdueAt).list(app.scope));
  assert.equal(queue.items[0]?.alerts?.overdue, "delivered");
  assert.equal(JSON.stringify(queue).includes("Private"), false);
  assert.equal(success(await new StaffQueue(app.ledger).list({ ...app.scope, tenantId: "foreign" })).items.length, 0);
});

test("review-required task alerts the operator before its due time", async () => {
  const app = await setup("operator-alert-review");
  await app.turn("handoff", "Need help", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  app.host.taskResult = value => ({ kind: "rejected", taskKey: value.key });
  await app.worker.process(app.callId, `${item.key}:open`, now);
  assert.equal((await app.state()).staffItems[item.key]?.status, "needsReview");
  const monitor = new StaffAlertMonitor(app.ledger, app.scope);
  assert.equal(success(await monitor.scan(now)), 1);
  const host = new ReferenceClinicHost([], []);
  const result = success(await new EffectRecovery(app.ledger, () => host, app.scope).recover(now));
  assert.equal(result.failed.length, 0);
  assert.deepEqual(host.alerts(app.scope).map(alert => alert.reason), ["needsReview"]);
  assert.equal((await app.state()).staffItems[item.key]?.alerts?.needsReview, "delivered");
});

test("crash after possible alert send reconciles its exact key without sending again", async () => {
  const app = await setup("operator-alert-restart");
  await app.turn("handoff", "Need help", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const host = new ReferenceClinicHost([], []);
  const monitor = new StaffAlertMonitor(app.ledger, app.scope);
  assert.equal(success(await monitor.scan(overdueAt)), 1);
  const effectId = `${item.key}:alert:overdue`;
  const marked = success(await app.runtime.markOperatorAlertPossiblySent(app.callId, effectId, overdueAt));
  const effect = marked.effects[effectId];
  assert.ok(effect && effect.kind === "operatorAlert");
  assert.equal((await host.sendAlert(effect.alert)).kind, "delivered");
  const restarted = new EffectRecovery(app.ledger, () => host, app.scope);
  assert.equal(success(await restarted.recover(overdueAt)).recovered, 0);
  assert.equal(success(await restarted.recover(afterRecovery)).recovered, 1);
  assert.equal((await app.state()).staffItems[item.key]?.alerts?.overdue, "uncertain");
  assert.equal(success(await restarted.recover("2026-09-29T10:01:03.000Z")).processed, 1);
  assert.equal((await app.state()).staffItems[item.key]?.alerts?.overdue, "delivered");
  assert.equal(host.alerts(app.scope).length, 1);
});

test("definitive alert failure remains visible and an obsolete pending alert cancels before send", async () => {
  const app = await setup("operator-alert-failure");
  await app.turn("handoff", "Need help", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const monitor = new StaffAlertMonitor(app.ledger, app.scope);
  success(await monitor.scan(overdueAt));
  const failingHost = new ReferenceClinicHost([], []);
  failingHost.sendAlert = async alert => ({ kind: "failed", alertKey: alert.alertKey });
  const result = success(await new EffectRecovery(app.ledger, () => failingHost, app.scope).recover(overdueAt));
  assert.deepEqual(result.failed.map(failure => failure.kind), ["effectFailure"]);
  assert.equal((await app.state()).staffItems[item.key]?.alerts?.overdue, "failed");

  const scoped = { tenantId: "operator-alert-cancel-tenant", clinicId: "operator-alert-cancel-clinic", locationId: "operator-alert-cancel-location" };
  const host = new ReferenceClinicHost([], []);
  const ledger = new MemoryLedger();
  const runtime = new CallRuntime(ledger, scoped);
  const policy = referenceDefaultPolicy(scoped);
  success(await runtime.start("cancel-alert-call", policy));
  success(await runtime.acceptTurn({ callId: "cancel-alert-call", turnId: "handoff", text: "Help", quality: "clear", at: now },
    { kind: "handoff", reason: "callerRequested" }, now));
  const target = Object.values(success(await runtime.read("cancel-alert-call")).staffItems)[0];
  assert.ok(target);
  await new EffectWorker(runtime, host).process("cancel-alert-call", `${target.key}:open`, now);
  success(await new StaffAlertMonitor(ledger, scoped).scan(overdueAt));
  const opened = success(await runtime.read("cancel-alert-call"));
  success(await runtime.requestStaffChange("cancel-alert-call", opened.version, target.key, "staff-actor", { kind: "resolve" }));
  const change = success(await runtime.read("cancel-alert-call")).staffItems[target.key]?.pendingChangeKey;
  assert.ok(change);
  await new EffectWorker(runtime, host).process("cancel-alert-call", `${change}:send`, overdueAt);
  success(await new EffectRecovery(ledger, () => host, scoped).recover(overdueAt));
  assert.equal(success(await runtime.read("cancel-alert-call")).staffItems[target.key]?.alerts?.overdue, "canceled");
  assert.equal(host.alerts(scoped).length, 0);
});
