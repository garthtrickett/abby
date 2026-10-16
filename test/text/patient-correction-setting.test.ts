import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { CommandGateway } from "../../src/reference/command-gateway.ts";
import type { GatewayCommand } from "../../src/reference/command-gateway.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { MemoryClinicPatientCorrectionSettingStore } from "../../src/reference/clinic-patient-correction-setting-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import type { Result } from "../../src/core/model.ts";
const now = "2026-10-04T06:00:00.000Z", scope = { tenantId: "correction-setting", clinicId: "clinic", locationId: "first" };
const change = "settings.patients.corrections.enabled.change.v1" as const, audit = "settings.patients.corrections.audit.v1" as const;
const value = <T>(result: Result<T, unknown>): T => { assert.ok(result.ok); return result.value; };

test("E2E-363 clinic correction settings are independently versioned across locations, hosts and captured calls", async () => {
  const policy = new MemoryPolicyStore("execute", () => now, undefined, { intake: "execute", patientUpdate: "execute" });
  const reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  const admin = new CommandGateway({ actorRef: "owner", role: "clinicAdmin", scope }, policy, reception);
  const other = { ...scope, locationId: "second" };
  const initial = value(await policy.read(scope));
  assert.equal(initial.patientCorrectionsEnabled, false); assert.equal(initial.patientCorrectionsVersion, "0"); assert.equal(initial.capabilities.patientUpdate, "unavailable");
  const before = value(await reception.startCall("correction-before", other, now));
  value(await policy.changeFirstTimeIntakeEnabled(scope, "0", true, "intake-owner"));
  value(await policy.changeBookingEnabled(scope, "0", true, "booking-owner"));
  assert.deepEqual(admin.listPermitted().find(d => d.id === change)!.preconditions, ["expectedClinicCorrectionVersion"]);
  assert.equal(value(await admin.submit({ kind: change, expectedVersion: "0", enabled: true })).kind, "settings");
  for (const location of [scope, other]) {
    const current = value(await policy.read(location)); assert.equal(current.patientCorrectionsEnabled, true); assert.equal(current.patientCorrectionsVersion, "1");
    assert.equal(current.capabilities.patientUpdate, "execute"); assert.equal(current.firstTimeIntakeVersion, "1");
  }
  const captured = value(await reception.startCall("correction-captured", other, now));
  assert.equal(before.policy.patientCorrectionsEnabled, false); assert.equal(captured.policy.patientCorrectionsVersion, "1");
  value(await policy.changePatientCorrectionsEnabled(other, "1", false, "other-owner"));
  assert.equal(value(await policy.read(scope)).patientCorrectionsVersion, "2"); assert.equal(captured.policy.patientCorrectionsVersion, "1");
  assert.equal(value(await policy.read(scope)).capabilities.patientUpdate, "unavailable");
  const history = value(await admin.submit({ kind: audit })); assert.equal(history.kind, "patientCorrectionSettingAudit");
  if (history.kind !== "patientCorrectionSettingAudit") throw new Error("wrong reply");
  assert.deepEqual(history.page.entries.map(e => [e.version, e.enabled, e.actorRef]), [["1", true, "owner"], ["2", false, "other-owner"]]);
  assert.deepEqual(value(await policy.listPatientCorrectionChanges(other)), history.page);
  assert.equal(value(await policy.read({ ...scope, clinicId: "foreign" })).patientCorrectionsVersion, "0");
  assert.equal(value(await policy.read({ ...scope, tenantId: "foreign" })).patientCorrectionsEnabled, false);
  assert.equal(value(await policy.listFirstTimeIntakeChanges(scope)).entries.length, 1);
});

test("E2E-363 settings cannot grant unsupported host permission, non-admin edits or forged actor/scope", async () => {
  const policy = new MemoryPolicyStore(), reception = new TextReception(new MemoryLedger(), policy, new ReferenceClinicHost([], []));
  for (const role of ["agent", "staff"] as const) {
    const client = new CommandGateway({ actorRef: role, role, scope }, policy, reception);
    assert.equal(client.listPermitted().some(d => d.id === change || d.id === audit), false);
    assert.deepEqual(await client.submit({ kind: change, expectedVersion: "0", enabled: true }), { ok: false, error: { kind: "forbidden" } });
  }
  const admin = new CommandGateway({ actorRef: "owner", role: "clinicAdmin", scope }, policy, reception);
  for (const command of [{ kind: change, expectedVersion: "0", enabled: "yes" }, { kind: change, expectedVersion: "0", enabled: true, actorRef: "forged" },
    { kind: change, expectedVersion: "0", enabled: true, scope }, { kind: audit, afterVersion: -1 }]) {
    assert.equal((await admin.submit(command as unknown as GatewayCommand)).ok, false);
  }
  value(await admin.submit({ kind: change, expectedVersion: "0", enabled: true }));
  const unsupported = value(await policy.read(scope)); assert.equal(unsupported.patientCorrectionsEnabled, true); assert.equal(unsupported.capabilities.patientUpdate, "unavailable");
});

test("E2E-363 memory clinic CAS, audit pagination and immutable history reject malformed changes", async () => {
  const store = new MemoryClinicPatientCorrectionSettingStore(() => now);
  const results = await Promise.all([store.changeEnabled(scope, "0", true, "one"), store.changeEnabled(scope, "0", false, "two")]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(value(await store.read(scope)).version, "1");
  for (let version = 1; version < 51; version++) value(await store.changeEnabled(scope, String(version), version % 2 === 0, "owner"));
  const first = value(await store.listChanges(scope)); assert.equal(first.entries.length, 50); assert.equal(first.nextAfterVersion, 50);
  (first.entries[0] as { actorRef: string }).actorRef = "mutated";
  assert.equal(value(await store.listChanges(scope)).entries[0]!.actorRef, "one");
  assert.equal(value(await store.listChanges(scope, 50)).entries.length, 1);
  for (const version of ["", "01", "-1", "1.5", "2147483647"]) assert.equal((await store.changeEnabled(scope, version, true, "owner")).ok, false);
  assert.equal((await store.changeEnabled(scope, "51", true, "private\ntext")).ok, false);
  assert.equal((await store.listChanges(scope, Number.MAX_SAFE_INTEGER + 1)).ok, false);
});
