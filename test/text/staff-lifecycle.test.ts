import assert from "node:assert/strict";
import test from "node:test";
import { EffectWorker } from "../../src/core/effect-worker.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import type { StaffChange, StaffChangeRequest } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { now, setup, success } from "./fixture.ts";

async function opened(id: string) {
  const app = await setup(id);
  await app.turn("handoff", "Please ask staff to call", { kind: "handoff", reason: "callerRequested" });
  const item = Object.values((await app.state()).staffItems)[0];
  assert.ok(item);
  const host = new ReferenceClinicHost([], []);
  const worker = new EffectWorker(app.runtime, host);
  await worker.process(app.callId, `${item.key}:open`, now);
  assert.equal((await app.state()).staffItems[item.key]?.status, "open");
  return { app, item, host, worker };
}

async function change(fixture: Awaited<ReturnType<typeof opened>>, request: StaffChangeRequest) {
  const current = await fixture.app.state();
  const requested = success(await fixture.app.runtime.requestStaffChange(fixture.app.callId, current.version, fixture.item.key, "staff-actor", request));
  const commandKey = requested.staffItems[fixture.item.key]?.pendingChangeKey;
  assert.ok(commandKey);
  await fixture.worker.process(fixture.app.callId, `${commandKey}:send`, now);
  return fixture.app.state();
}

test("staff can acknowledge, reassign, and resolve an opened task", async () => {
  const fixture = await opened("staff-lifecycle");
  const { app, item, host } = fixture;
  const initial = await app.state();
  assert.equal((await app.runtime.requestStaffChange(app.callId, initial.version - 1, item.key, "staff-actor", { kind: "acknowledge" })).ok, false);
  const acknowledged = await change(fixture, { kind: "acknowledge" });
  assert.equal(acknowledged.staffItems[item.key]?.status, "acknowledged");
  assert.equal(acknowledged.staffItems[item.key]?.pendingChangeKey, undefined);
  assert.equal(host.tasks(app.scope)[0]?.status, "acknowledged");
  const reassigned = await change(fixture, { kind: "reassign", target: "operator" });
  assert.equal(reassigned.staffItems[item.key]?.status, "open");
  assert.deepEqual(reassigned.staffItems[item.key]?.destination, app.policy.operatorQueue);
  assert.deepEqual(host.tasks(app.scope)[0]?.destination, app.policy.operatorQueue);
  const resolved = await change(fixture, { kind: "resolve" });
  assert.equal(resolved.staffItems[item.key]?.status, "resolved");
  assert.equal(host.tasks(app.scope)[0]?.status, "resolved");
  assert.equal(Object.values(resolved.effects).filter(effect => effect.kind === "staffChange").length, 3);
  assert.equal((await app.runtime.requestStaffChange(app.callId, resolved.version, item.key, "staff-actor", { kind: "acknowledge" })).ok, false);
});

test("staff can resolve follow-up after the admitted voice call has ended", async () => {
  const scope = { tenantId: "ended-staff-tenant", clinicId: "ended-staff-clinic", locationId: "ended-staff-location" };
  const policy = { scope, policyVersion: "1", automationVersion: "0", automationEnabled: true, bookingEnabled: false,
    capabilities: { book: "unavailable" as const, cancel: "requestOnly" as const, reschedule: "requestOnly" as const,
      intake: "requestOnly" as const, transfer: "requestOnly" as const },
    staffDestination: { kind: "owner" as const, ownerRef: "ended-staff-owner" },
    operatorQueue: { kind: "queue" as const, queueRef: "ended-staff-operator" } };
  const callId = "ended-staff-call";
  const runtime = new CallRuntime(new MemoryLedger(), scope);
  const host = new ReferenceClinicHost([], []);
  const worker = new EffectWorker(runtime, host);
  success(await runtime.admit(callId, policy, { key: { accountRef: "demo-account", providerCallRef: callId },
    dialedNumber: "+61000000001", acceptedAt: now, deadline: "2026-09-28T10:00:30.000Z" }));
  success(await runtime.activate(callId, "ended-session", now));
  const handedOff = success(await runtime.acceptTurn({ callId, sessionId: "ended-session", turnId: "staff-needed",
    text: "Please call me", quality: "clear", at: now }, { kind: "handoff", reason: "callerRequested" }, now));
  const item = Object.values(handedOff.staffItems)[0];
  assert.ok(item);
  await worker.process(callId, `${item.key}:open`, now);
  success(await runtime.endCall(callId, "ended-session", "2026-09-28T10:00:01.000Z"));
  const ended = success(await runtime.read(callId));
  assert.equal(ended.lifecycle, "ended");
  const requested = success(await runtime.requestStaffChange(callId, ended.version, item.key, "staff-actor", { kind: "resolve" }));
  const commandKey = requested.staffItems[item.key]?.pendingChangeKey;
  assert.ok(commandKey);
  await worker.process(callId, `${commandKey}:send`, "2026-09-28T10:00:02.000Z");
  const resolved = success(await runtime.read(callId));
  assert.equal(resolved.lifecycle, "ended");
  assert.equal(resolved.staffItems[item.key]?.status, "resolved");
});

test("staff lifecycle capability is absent when the host cannot confirm changes", async () => {
  const scope = { tenantId: "no-lifecycle-tenant", clinicId: "no-lifecycle-clinic", locationId: "no-lifecycle-location" };
  const reference = new ReferenceClinicHost([], []);
  const host = {
    resolveBooking: reference.resolveBooking.bind(reference),
    readKnowledge: reference.readKnowledge.bind(reference),
    write: reference.write.bind(reference),
    reconcile: reference.reconcile.bind(reference),
    openTask: reference.openTask.bind(reference),
    reconcileTask: reference.reconcileTask.bind(reference),
  };
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(new MemoryLedger(), policy, host);
  const gateway = new CommandGateway({ actorRef: "staff", role: "staff", scope }, policy, reception);
  assert.equal(gateway.listPermitted().some(item => item.id === "staff.change.v1"), false);
  const result = await gateway.submit({ kind: "staff.change.v1", callId: "call", taskKey: "task", expectedVersion: 0,
    change: { kind: "resolve" }, now });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "forbidden");
});

test("lost staff-change receipt reconciles exact host outcome without replaying the change", async () => {
  const fixture = await opened("staff-change-lost");
  const { app, item, host } = fixture;
  const original = host.advanceTask.bind(host);
  let sends = 0;
  host.advanceTask = async (command: StaffChange) => {
    sends += 1;
    const receipt = await original(command);
    if (sends === 1) throw new Error("response lost after host commit");
    return receipt;
  };
  const requested = success(await app.runtime.requestStaffChange(app.callId, (await app.state()).version, item.key,
    "staff-actor", { kind: "resolve" }));
  const commandKey = requested.staffItems[item.key]?.pendingChangeKey;
  assert.ok(commandKey);
  const worker = new EffectWorker(app.runtime, host);
  await worker.process(app.callId, `${commandKey}:send`, now);
  const uncertain = await app.state();
  assert.equal(uncertain.staffItems[item.key]?.status, "open");
  assert.equal(uncertain.staffItems[item.key]?.reviewRequired, true);
  assert.equal(uncertain.effects[`${commandKey}:send:reconcile`]?.status, "pending");
  await worker.process(app.callId, `${commandKey}:send:reconcile`, now);
  const recovered = await app.state();
  assert.equal(recovered.staffItems[item.key]?.status, "resolved");
  assert.equal(recovered.staffItems[item.key]?.reviewRequired, undefined);
  assert.equal(recovered.effects[`${commandKey}:send`]?.status, "completed");
  assert.equal(sends, 1);
  assert.equal(host.tasks(app.scope)[0]?.status, "resolved");
});

test("crash after possible staff-change send reconciles the original command key", async () => {
  const fixture = await opened("staff-change-crash");
  const { app, item, host } = fixture;
  const requested = success(await app.runtime.requestStaffChange(app.callId, (await app.state()).version, item.key,
    "staff-actor", { kind: "acknowledge" }));
  const commandKey = requested.staffItems[item.key]?.pendingChangeKey;
  assert.ok(commandKey);
  const effectId = `${commandKey}:send`;
  const effect = requested.effects[effectId];
  assert.ok(effect && effect.kind === "staffChange");
  success(await app.runtime.markStaffChangePossiblySent(app.callId, effectId, now));
  assert.equal((await host.advanceTask(effect.change)).kind, "applied");
  assert.equal((await host.advanceTask(effect.change)).kind, "applied");
  assert.equal((await host.advanceTask({ ...effect.change, actorRef: "different-actor" })).kind, "rejected");
  assert.equal((await app.runtime.recoverStaffChangePossiblySent(app.callId, effectId, now)).ok, false);
  success(await app.runtime.recoverStaffChangePossiblySent(app.callId, effectId, "2026-09-28T10:01:01.000Z"));
  assert.equal((await app.state()).staffItems[item.key]?.reviewRequired, true);
  await new EffectWorker(app.runtime, host).process(app.callId, `${effectId}:reconcile`, now);
  const recovered = await app.state();
  assert.equal(recovered.staffItems[item.key]?.status, "acknowledged");
  assert.equal(recovered.staffItems[item.key]?.reviewRequired, undefined);
  assert.equal(recovered.effects[effectId]?.status, "completed");
  assert.equal(host.tasks(app.scope).length, 1);
  assert.equal(host.tasks(app.scope)[0]?.status, "acknowledged");
});

test("rejected or unknown host changes never mark the task resolved", async () => {
  for (const outcome of ["rejected", "uncertain"] as const) {
    const fixture = await opened(`staff-change-${outcome}`);
    const { app, item, host } = fixture;
    host.advanceTask = async command => ({ kind: outcome, commandKey: command.commandKey, taskKey: command.taskKey });
    if (outcome === "uncertain") host.reconcileTaskChange = async command => ({ kind: "stillUnknown", commandKey: command.commandKey, taskKey: command.taskKey });
    const requested = success(await app.runtime.requestStaffChange(app.callId, (await app.state()).version, item.key,
      "staff-actor", { kind: "resolve" }));
    const commandKey = requested.staffItems[item.key]?.pendingChangeKey;
    assert.ok(commandKey);
    const worker = new EffectWorker(app.runtime, host);
    await worker.process(app.callId, `${commandKey}:send`, now);
    if (outcome === "uncertain") await worker.process(app.callId, `${commandKey}:send:reconcile`, now);
    const current = await app.state();
    assert.equal(current.staffItems[item.key]?.status, "open");
    assert.equal(current.staffItems[item.key]?.reviewRequired, true);
    assert.equal(host.tasks(app.scope)[0]?.status, "open");
    assert.equal(current.staffItems[item.key]?.pendingChangeKey === undefined, outcome === "rejected");
  }
});
