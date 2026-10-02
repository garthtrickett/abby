import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import type { Result } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayCommand } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";

const scope = { tenantId: "cancellation-setting", clinicId: "clinic", locationId: "main" };
const now = "2026-10-02T10:00:00.000Z";
const change = "settings.appointments.cancellation.enabled.change.v1" as const;
const audit = "settings.appointments.cancellation.audit.v1" as const;
function value<T>(result: Result<T, unknown>): T { assert.ok(result.ok); return result.value; }

test("E2E-252 cancellation command is versioned, scoped, admin-only and limited by host permission", async () => {
  const policy = new MemoryPolicyStore("execute", () => now, undefined, "execute");
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const admin = new CommandGateway({ actorRef: "clinic-owner", role: "clinicAdmin", scope }, policy, reception);
  const initial = value(await policy.read(scope));
  assert.equal(initial.cancellationEnabled, false);
  assert.equal(initial.capabilities.cancel, "unavailable");
  const admittedBefore = value(await reception.startCall("before", scope, now));
  for (const role of ["staff", "agent"] as const) {
    const gateway = new CommandGateway({ actorRef: role, role, scope }, policy, reception);
    assert.equal(gateway.listPermitted().some(item => item.id === change || item.id === audit), false);
    assert.deepEqual(await gateway.submit({ kind: change, expectedVersion: "0", enabled: true }),
      { ok: false, error: { kind: "forbidden" } });
    assert.deepEqual(await gateway.submit({ kind: audit }), { ok: false, error: { kind: "forbidden" } });
  }
  for (const invalid of [{ kind: change, expectedVersion: "0", enabled: "yes" },
    { kind: change, expectedVersion: "0", enabled: true, actorRef: "forged" },
    { kind: change, expectedVersion: "0", enabled: true, scope: { ...scope, locationId: "other" } }]) {
    // Deliberately cross the typed interface with untrusted JSON to exercise runtime validation.
    assert.deepEqual(await admin.submit(invalid as unknown as GatewayCommand), { ok: false, error: { kind: "invalid" } });
  }
  const enabled = value(await admin.submit({ kind: change, expectedVersion: "0", enabled: true }));
  assert.equal(enabled.kind, "settings");
  assert.equal(value(await policy.read(scope)).capabilities.cancel, "execute");
  const admittedEnabled = value(await reception.startCall("enabled", scope, now));
  assert.equal(admittedEnabled.policy.cancellationEnabled, true);
  assert.equal(admittedBefore.policy.capabilities.cancel, "unavailable");
  assert.deepEqual(await admin.submit({ kind: change, expectedVersion: "0", enabled: false }),
    { ok: false, error: { kind: "versionConflict" } });
  value(await admin.submit({ kind: change, expectedVersion: "1", enabled: false }));
  assert.equal(admittedEnabled.policy.capabilities.cancel, "execute");
  assert.equal(value(await reception.startCall("disabled", scope, now)).policy.capabilities.cancel, "unavailable");
  const changes = value(await admin.submit({ kind: audit }));
  assert.equal(changes.kind, "cancellationSettingAudit");
  if (changes.kind !== "cancellationSettingAudit") throw new Error("wrong audit reply");
  assert.deepEqual(changes.page.entries.map(entry => [entry.version, entry.enabled, entry.previousEnabled, entry.actorRef]),
    [["1", true, false, "clinic-owner"], ["2", false, true, "clinic-owner"]]);
  assert.equal(value(await policy.listBookingChanges(scope)).entries.length, 0);
  assert.equal(value(await policy.read({ ...scope, locationId: "other" })).cancellationEnabled, false);
  assert.equal(value(await policy.listCancellationChanges({ ...scope, clinicId: "other" })).entries.length, 0);

  const unavailable = new MemoryPolicyStore("execute", () => now, undefined, "unavailable");
  assert.equal(value(await unavailable.changeCancellationEnabled(scope, "0", true, "owner")).capabilities.cancel, "unavailable");
});

test("E2E-252 cancellation audit pages exclude booking edits and failed changes", async () => {
  let failedClock = false;
  const policy = new MemoryPolicyStore("execute", () => {
    if (failedClock) throw new Error("synthetic clock failure");
    return now;
  });
  failedClock = true;
  assert.deepEqual(await policy.changeCancellationEnabled(scope, "0", true, "owner"),
    { ok: false, error: { kind: "storageFailure" } });
  assert.equal(value(await policy.read(scope)).policyVersion, "0");
  failedClock = false;
  for (let index = 0; index < 51; index += 1) {
    const current = value(await policy.read(scope));
    value(await policy.changeCancellationEnabled(scope, current.policyVersion, index % 2 === 0, "owner"));
  }
  value(await policy.changeBookingEnabled(scope, "51", true, "book-owner"));
  const first = value(await policy.listCancellationChanges(scope));
  assert.equal(first.entries.length, 50);
  assert.equal(first.nextAfterVersion, 50);
  assert.deepEqual(value(await policy.listCancellationChanges(scope, first.nextAfterVersion)).entries.map(row => row.version), ["51"]);
  assert.deepEqual(await policy.listCancellationChanges(scope, -1), { ok: false, error: { kind: "invalidValue" } });
});
