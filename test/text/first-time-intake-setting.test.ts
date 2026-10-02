import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { Result } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayCommand } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";

const scope = { tenantId: "intake-setting", clinicId: "clinic", locationId: "main" };
const otherLocation = { ...scope, locationId: "second" };
const now = "2026-10-02T16:00:00.000Z";
const change = "settings.patients.firstTimeIntake.enabled.change.v1" as const;
const audit = "settings.patients.firstTimeIntake.audit.v1" as const;
function value<T>(result: Result<T, unknown>): T { assert.ok(result.ok); return result.value; }

test("E2E-255 first-time intake is clinic-wide with independent version and captured call policy", async () => {
  const policy = new MemoryPolicyStore("execute", () => now, undefined, { intake: "execute" });
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const admin = new CommandGateway({ actorRef: "clinic-owner", role: "clinicAdmin", scope }, policy, reception);
  const secondAdmin = new CommandGateway({ actorRef: "second-owner", role: "clinicAdmin", scope: otherLocation }, policy, reception);
  const initial = value(await policy.read(scope));
  assert.equal(initial.firstTimeIntakeEnabled, false);
  assert.equal(initial.firstTimeIntakeVersion, "0");
  assert.equal(initial.capabilities.intake, "unavailable");
  const before = value(await reception.startCall("before", otherLocation, now));
  const descriptor = admin.listPermitted().find(item => item.id === change);
  assert.ok(descriptor);
  assert.deepEqual(descriptor.preconditions, ["expectedClinicIntakeVersion"]);

  // A location setting advances a different authority. Intake must still accept clinic version zero.
  value(await policy.changeBookingEnabled(scope, "0", true, "booking-owner"));
  const enabled = value(await admin.submit({ kind: change, expectedVersion: "0", enabled: true }));
  assert.equal(enabled.kind, "settings");
  const main = value(await policy.read(scope));
  const second = value(await policy.read(otherLocation));
  assert.equal(main.policyVersion, "1");
  assert.equal(second.policyVersion, "0");
  for (const current of [main, second]) {
    assert.equal(current.firstTimeIntakeEnabled, true);
    assert.equal(current.firstTimeIntakeVersion, "1");
    assert.equal(current.capabilities.intake, "execute");
  }
  const active = value(await reception.startCall("enabled", otherLocation, now));
  assert.equal(before.policy.firstTimeIntakeEnabled, false);
  assert.equal(before.policy.capabilities.intake, "unavailable");
  assert.deepEqual(await secondAdmin.submit({ kind: change, expectedVersion: "0", enabled: false }),
    { ok: false, error: { kind: "versionConflict" } });
  value(await secondAdmin.submit({ kind: change, expectedVersion: "1", enabled: false }));
  assert.equal(active.policy.firstTimeIntakeVersion, "1");
  assert.equal(active.policy.capabilities.intake, "execute");
  const next = value(await reception.startCall("disabled", scope, now));
  assert.equal(next.policy.firstTimeIntakeVersion, "2");
  assert.equal(next.policy.firstTimeIntakeEnabled, false);
  assert.equal(next.policy.capabilities.intake, "unavailable");
  const changes = value(await admin.submit({ kind: audit }));
  assert.equal(changes.kind, "firstTimeIntakeSettingAudit");
  if (changes.kind !== "firstTimeIntakeSettingAudit") throw new Error("wrong audit reply");
  assert.deepEqual(changes.page.entries.map(row => [row.version, row.enabled, row.previousEnabled, row.actorRef]),
    [["1", true, false, "clinic-owner"], ["2", false, true, "second-owner"]]);
  assert.deepEqual(value(await policy.listFirstTimeIntakeChanges(otherLocation)), changes.page);
  for (const foreign of [{ ...scope, tenantId: "other" }, { ...scope, clinicId: "other" }]) {
    const current = value(await policy.read(foreign));
    assert.equal(current.firstTimeIntakeEnabled, false);
    assert.equal(current.firstTimeIntakeVersion, "0");
    assert.deepEqual(value(await policy.listFirstTimeIntakeChanges(foreign)).entries, []);
  }
  assert.equal(value(await policy.listBookingChanges(scope)).entries.length, 1);
  assert.deepEqual(value(await policy.listCancellationChanges(scope)).entries, []);
  assert.deepEqual(value(await policy.listReschedulingChanges(scope)).entries, []);
});

test("E2E-255 first-time intake commands reject forged fields and require admin and proven host mode", async () => {
  const policy = new MemoryPolicyStore();
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const admin = new CommandGateway({ actorRef: "owner", role: "clinicAdmin", scope }, policy, reception);
  for (const role of ["staff", "agent"] as const) {
    const gateway = new CommandGateway({ actorRef: role, role, scope }, policy, reception);
    assert.equal(gateway.listPermitted().some(item => item.id === change || item.id === audit), false);
    assert.deepEqual(await gateway.submit({ kind: change, expectedVersion: "0", enabled: true }),
      { ok: false, error: { kind: "forbidden" } });
    assert.deepEqual(await gateway.submit({ kind: audit }), { ok: false, error: { kind: "forbidden" } });
  }
  for (const invalid of [
    { kind: change, expectedVersion: "0", enabled: "yes" },
    { kind: change, expectedVersion: "0", enabled: true, actorRef: "forged" },
    { kind: change, expectedVersion: "0", enabled: true, scope: { ...scope, clinicId: "other" } },
    { kind: audit, afterVersion: -1 },
    { kind: audit, afterVersion: 0.5 },
  ]) {
    assert.deepEqual(await admin.submit(invalid as unknown as GatewayCommand),
      { ok: false, error: { kind: "invalid" } });
  }
  assert.deepEqual(value(await policy.listFirstTimeIntakeChanges(scope)).entries, []);
  value(await admin.submit({ kind: change, expectedVersion: "0", enabled: true }));
  const unsupported = value(await policy.read(scope));
  assert.equal(unsupported.firstTimeIntakeEnabled, true);
  assert.equal(unsupported.capabilities.intake, "unavailable");
  assert.equal(value(await reception.startCall("unsupported", scope, now)).policy.capabilities.intake, "unavailable");
});

test("E2E-255 clinic intake concurrent admin edits have one winner and audit supports trusted opaque actors", async () => {
  const policy = new MemoryPolicyStore("execute", () => now, undefined, { intake: "requestOnly" });
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  // The host contract allows up to 256 characters; discovery must describe the same output contract.
  const actorRef = "a".repeat(200);
  const first = new CommandGateway({ actorRef, role: "clinicAdmin", scope }, policy, reception);
  const second = new CommandGateway({ actorRef: "second-owner", role: "clinicAdmin", scope: otherLocation }, policy, reception);
  const results = await Promise.all([
    first.submit({ kind: change, expectedVersion: "0", enabled: true }),
    second.submit({ kind: change, expectedVersion: "0", enabled: true }),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.error.kind), ["versionConflict"]);
  const changes = value(await first.submit({ kind: audit }));
  assert.equal(changes.kind, "firstTimeIntakeSettingAudit");
  if (changes.kind !== "firstTimeIntakeSettingAudit") throw new Error("wrong audit reply");
  assert.equal(changes.page.entries.length, 1);
  assert.equal(changes.page.entries[0]?.actorRef, actorRef);
  assert.equal(value(await policy.read(otherLocation)).capabilities.intake, "requestOnly");
  const after = value(await second.submit({ kind: audit, afterVersion: 1 }));
  assert.equal(after.kind, "firstTimeIntakeSettingAudit");
  if (after.kind !== "firstTimeIntakeSettingAudit") throw new Error("wrong audit reply");
  assert.deepEqual(after.page.entries, []);
});
