import assert from "node:assert/strict";
import test from "node:test";
import { MemoryClinicNotificationSettingStore } from "../../src/reference/clinic-notification-setting-store.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { captureNotificationPolicy, defaultNotificationSettings, resolveNotification } from "../../src/core/notification-policy.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { ok } from "../../src/core/model.ts";
import { notificationRegistry, notificationSettingsContract } from "../support/notification-settings-contract.ts";
import type { TimerPort } from "../../src/core/timer.ts";

const now = "2026-10-02T21:00:00.000Z";
const scope = { tenantId: "notification-capture", clinicId: "clinic", locationId: "main" };
notificationSettingsContract("E2E-257 memory", registry => new MemoryClinicNotificationSettingStore(() => now, registry));

test("E2E-257 notification admission captures the owner and host version without inheriting forged policy authority", async () => {
  let hostVersion = "host-v1";
  let supported = true;
  const policy = new MemoryPolicyStore(undefined, () => now, undefined, undefined, undefined, {
    resolve: async (bound, kind) => supported ? ok({ scope: bound, kind, hostVersion, owners: ["host", "abby"],
      nativeDelivery: "managedOnly", ready: true }) : { ok: false, error: { kind: "readinessFailed", missing: ["notificationOwner"] } },
  });
  const initial = await policy.read(scope);
  assert.ok(initial.ok);
  assert.deepEqual(initial.value.notificationSettings, defaultNotificationSettings());
  assert.deepEqual(initial.value.notificationBindings, {});
  const selected = await policy.changeNotificationOwner(scope, "0", "bookingConfirmation", "host", "owner");
  assert.ok(selected.ok);
  assert.equal(selected.value.policyVersion, "0");
  assert.deepEqual(selected.value.notificationBindings?.bookingConfirmation,
    { scope, kind: "bookingConfirmation", owner: "host", settingsVersion: "1", hostVersion: "host-v1" });
  const runtime = new CallRuntime(new MemoryLedger(), scope);
  assert.ok((await runtime.start("captured-owner", selected.value)).ok);
  hostVersion = "host-v2";
  assert.ok((await policy.changeNotificationOwner(scope, "1", "bookingConfirmation", "abby", "next-owner")).ok);
  const active = await runtime.read("captured-owner");
  assert.ok(active.ok);
  assert.equal(active.value.policy.notificationBindings?.bookingConfirmation?.owner, "host");
  assert.equal(active.value.policy.notificationBindings?.bookingConfirmation?.hostVersion, "host-v1");
  const next = await policy.read({ ...scope, locationId: "second" });
  assert.ok(next.ok);
  assert.equal(next.value.notificationBindings?.bookingConfirmation?.owner, "abby");
  assert.equal(next.value.notificationBindings?.bookingConfirmation?.scope.locationId, "second");
  supported = false;
  const withdrawn = await policy.read(scope);
  assert.ok(withdrawn.ok);
  assert.equal(withdrawn.value.notificationSettings?.owners.bookingConfirmation, "abby");
  assert.deepEqual(withdrawn.value.notificationBindings, {});
  const forged = await captureNotificationPolicy({ ...selected.value, notificationBindings: selected.value.notificationBindings },
    selected.value.notificationSettings!);
  assert.deepEqual(forged.notificationBindings, {});
  const cleared = await policy.changeNotificationOwner(scope, "2", "bookingConfirmation", null, "owner");
  assert.ok(cleared.ok);
  assert.deepEqual(cleared.value.notificationBindings, {});
});

test("E2E-257 notification capture resolves independent kinds in parallel and clones registry output", async () => {
  const declarations: unknown[] = [];
  const pending: Array<() => void> = [];
  const settings = { version: "3", owners: { bookingConfirmation: "host", cancellationConfirmation: "abby", reschedulingConfirmation: "host" } } as const;
  const capturing = captureNotificationPolicy(referenceDefaultPolicy(scope), settings, { resolve: async (bound, kind) => {
    await new Promise<void>(resolve => pending.push(resolve));
    const declaration = { scope: bound, kind, hostVersion: "v1", owners: ["host", "abby"] as const,
      nativeDelivery: "managedOnly" as const, ready: true as const };
    declarations.push(declaration);
    return ok(declaration);
  } });
  // Each resolver starts before any is allowed to return.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(pending.length, 3);
  for (const resolve of pending) resolve();
  const captured = await capturing;
  assert.equal(Object.keys(captured.notificationBindings!).length, 3);
  const mutable = declarations[0] as { scope: { tenantId: string } };
  mutable.scope.tenantId = "forged";
  assert.equal(captured.notificationBindings?.bookingConfirmation?.scope.tenantId, scope.tenantId);
});

test("E2E-257 a hung notification host lookup has a bounded deadline, abort and typed readiness failure", async () => {
  let fire!: () => void;
  let observed: AbortSignal | undefined;
  let canceled = false;
  const timer: TimerPort = { schedule: (callback, delay) => { assert.equal(delay, 1500); fire = callback; return "handle"; },
    cancel: handle => { assert.equal(handle, "handle"); canceled = true; } };
  const resolving = resolveNotification({ resolve: async (_scope, _kind, signal) => {
    observed = signal;
    return new Promise(() => {});
  } }, scope, "bookingConfirmation", "host", timer);
  await Promise.resolve();
  fire();
  assert.deepEqual(await resolving, { ok: false, error: { kind: "readinessFailed", missing: ["notificationOwner"] } });
  assert.equal(observed?.aborted, true);
  assert.equal(canceled, true);
});

test("E2E-257 failed clinic audit clocks cannot commit a notification preference", async () => {
  for (const clock of [() => { throw new Error("clock unavailable"); }, () => "not-a-date"]) {
    const store = new MemoryClinicNotificationSettingStore(clock, notificationRegistry());
    assert.deepEqual(await store.changeOwner(scope, "0", "bookingConfirmation", "host", "owner"),
      { ok: false, error: { kind: "storageFailure" } });
    assert.deepEqual(await store.read(scope), ok(defaultNotificationSettings()));
    assert.deepEqual(await store.listChanges(scope), ok({ entries: [] }));
  }
});
