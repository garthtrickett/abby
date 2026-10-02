import assert from "node:assert/strict";
import test from "node:test";
import type { Result } from "../../src/core/model.ts";
import { MemoryClinicIntakeSettingStore } from "../../src/reference/clinic-intake-setting-store.ts";

const now = "2026-10-02T16:00:00.000Z";
const first = { tenantId: "intake-settings", clinicId: "clinic", locationId: "first" };
const second = { ...first, locationId: "second" };
function value<T>(result: Result<T, unknown>): T { assert.ok(result.ok); return result.value; }

test("E2E-255 SET-005 persistence shares a clinic version across locations and isolates other clinics and tenants", async () => {
  const store = new MemoryClinicIntakeSettingStore(() => now);
  assert.deepEqual(value(await store.read(first)), { version: "0", enabled: false });
  const changes = await Promise.all([
    store.changeEnabled(first, "0", true, "owner-first"),
    store.changeEnabled(second, "0", false, "owner-second"),
  ]);
  assert.equal(changes.filter(row => row.ok).length, 1);
  assert.deepEqual(changes.filter(row => !row.ok), [{ ok: false, error: { kind: "versionConflict" } }]);
  assert.deepEqual(value(await store.read(second)), { version: "1", enabled: true });
  assert.deepEqual(value(await store.read({ ...first, clinicId: "other" })), { version: "0", enabled: false });
  assert.deepEqual(value(await store.read({ ...first, tenantId: "other" })), { version: "0", enabled: false });
  value(await store.changeEnabled(second, "1", false, "owner-second"));
  assert.deepEqual(value(await store.read(first)), { version: "2", enabled: false });
  const audit = value(await store.listChanges(first));
  assert.deepEqual(audit.entries.map(row => [row.version, row.enabled, row.previousEnabled, row.actorRef]),
    [["1", true, false, "owner-first"], ["2", false, true, "owner-second"]]);
  assert.deepEqual(value(await store.listChanges(second)), audit);
  assert.deepEqual(value(await store.listChanges({ ...first, clinicId: "other" })), { entries: [] });
  // A returned object is not a mutable reference into the store.
  const returned = value(await store.read(first)) as { version: string; enabled: boolean };
  returned.enabled = true;
  assert.equal(value(await store.read(first)).enabled, false);
  const opaque = { tenantId: "native/tenant 42", clinicId: "native/clinic 17" };
  assert.deepEqual(value(await store.changeEnabled(opaque, "0", true, "owner")), { version: "1", enabled: true });
  assert.deepEqual(value(await store.read(opaque)), { version: "1", enabled: true });
  assert.equal(value(await store.read(first)).enabled, false);
});

test("E2E-255 SET-005 persistence rejects invalid input and clock failures without changing state or history", async () => {
  let clock: "valid" | "throw" | "invalid" = "valid";
  const store = new MemoryClinicIntakeSettingStore(() => {
    if (clock === "throw") throw new Error("synthetic clock unavailable");
    return clock === "invalid" ? "not a timestamp" : now;
  });
  for (const mode of ["throw", "invalid"] as const) {
    clock = mode;
    assert.deepEqual(await store.changeEnabled(first, "0", true, "owner"), { ok: false, error: { kind: "storageFailure" } });
    assert.deepEqual(value(await store.read(first)), { version: "0", enabled: false });
    assert.deepEqual(value(await store.listChanges(first)), { entries: [] });
  }
  clock = "valid";
  assert.deepEqual(await store.changeEnabled(first, "0", "patient-canary" as unknown as boolean, "owner"),
    { ok: false, error: { kind: "invalidValue" } });
  assert.deepEqual(await store.changeEnabled(first, "0", true, " "), { ok: false, error: { kind: "invalidValue" } });
  assert.deepEqual(await store.read({ ...first, clinicId: "" }), { ok: false, error: { kind: "invalidValue" } });
  for (let version = 0; version < 51; version++) {
    value(await store.changeEnabled(version % 2 ? second : first, String(version), version % 2 === 0, "owner"));
  }
  const page = value(await store.listChanges(second));
  assert.equal(page.entries.length, 50);
  assert.equal(page.nextAfterVersion, 50);
  assert.deepEqual(value(await store.listChanges(first, page.nextAfterVersion)).entries.map(row => row.version), ["51"]);
  for (const cursor of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(await store.listChanges(first, cursor), { ok: false, error: { kind: "invalidValue" } });
  }
});
