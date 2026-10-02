import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinicIntakeSettingStore } from "../../src/storage/postgres-clinic-intake-setting.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });

test("E2E-255 standalone clinic intake stays unavailable and has no competing location policy authority", async () => {
  const first = { tenantId: `intake-minimal-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  const second = { ...first, locationId: "second" };
  const defaults = (scope: typeof first) => ({ ...referenceDefaultPolicy(scope),
    firstTimeIntakeEnabled: true, firstTimeIntakeVersion: "999" });
  const compose = () => new PostgresPolicyStore(db, defaults, "unavailable", undefined, false,
    "standaloneMinimal", false, { intake: "execute" });
  const policy = compose();
  const initial = await policy.read(first);
  assert.ok(initial.ok);
  assert.equal(initial.value.firstTimeIntakeEnabled, false);
  assert.equal(initial.value.firstTimeIntakeVersion, "0");
  const enabled = await policy.changeFirstTimeIntakeEnabled(first, "0", true, "owner");
  assert.ok(enabled.ok);
  assert.equal(enabled.value.firstTimeIntakeEnabled, true);
  assert.equal(enabled.value.firstTimeIntakeVersion, "1");
  assert.equal(enabled.value.policyVersion, "0");
  assert.equal(enabled.value.capabilities.intake, "unavailable");
  const locationEdit = await policy.changeBookingEnabled(first, "0", false, "booking-owner");
  assert.ok(locationEdit.ok);
  assert.equal(locationEdit.value.policyVersion, "1");
  assert.equal(locationEdit.value.firstTimeIntakeVersion, "1");
  const reconnected = await compose().read(second);
  assert.ok(reconnected.ok);
  assert.equal(reconnected.value.firstTimeIntakeEnabled, true);
  assert.equal(reconnected.value.firstTimeIntakeVersion, "1");
  assert.equal(reconnected.value.capabilities.intake, "unavailable");
  assert.equal(reconnected.value.policyVersion, "0");
  const rows = await sql<{ policy: Record<string, unknown> }>`select policy from clinic_settings
    where tenant_id = ${first.tenantId}`.execute(db);
  assert.equal(rows.rows.length, 2);
  for (const { policy: stored } of rows.rows) {
    assert.equal(Object.hasOwn(stored, "firstTimeIntakeEnabled"), false);
    assert.equal(Object.hasOwn(stored, "firstTimeIntakeVersion"), false);
    assert.deepEqual(Object.keys(stored).sort(),
      ["scope", "policyVersion", "bookingEnabled", "afterHoursMode", "greeting", "cancellationEnabled", "reschedulingEnabled"].sort());
  }
  assert.deepEqual(await policy.changeFirstTimeIntakeEnabled(second, "0", false, "owner"),
    { ok: false, error: { kind: "versionConflict" } });
  const disabled = await policy.changeFirstTimeIntakeEnabled(second, "1", false, "second-owner");
  assert.ok(disabled.ok);
  assert.equal(disabled.value.firstTimeIntakeVersion, "2");
  const audit = await compose().listFirstTimeIntakeChanges(first);
  assert.ok(audit.ok);
  assert.deepEqual(audit.value.entries.map(row => [row.version, row.enabled, row.actorRef]),
    [["1", true, "owner"], ["2", false, "second-owner"]]);
});

test("E2E-255 an authorized host intake mode is independent of the location booking capability", async () => {
  const scope = { tenantId: `intake-embedded-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const compose = (mode: "execute" | "unavailable") => new PostgresPolicyStore(db, referenceDefaultPolicy,
    "unavailable", undefined, false, "unsafeReference", false, { intake: mode });
  const policy = compose("execute");
  assert.ok((await policy.changeFirstTimeIntakeEnabled(scope, "0", true, "owner")).ok);
  assert.ok((await policy.changeBookingEnabled(scope, "0", false, "booking-owner")).ok);
  const read = await compose("execute").read(scope);
  assert.ok(read.ok);
  assert.equal(read.value.firstTimeIntakeEnabled, true);
  assert.equal(read.value.capabilities.intake, "execute");
  assert.equal(read.value.capabilities.book, "unavailable");
  const unsupported = await compose("unavailable").read(scope);
  assert.ok(unsupported.ok);
  assert.equal(unsupported.value.firstTimeIntakeEnabled, true);
  assert.equal(unsupported.value.capabilities.intake, "unavailable");
  const rows = await sql<{ policy: Record<string, unknown> }>`select policy from clinic_settings
    where tenant_id = ${scope.tenantId}`.execute(db);
  assert.equal(rows.rows.length, 2);
  for (const { policy: stored } of rows.rows) {
    assert.equal(Object.hasOwn(stored, "firstTimeIntakeEnabled"), false);
    assert.equal(Object.hasOwn(stored, "firstTimeIntakeVersion"), false);
  }
});

test("E2E-255 SET-005 PostgreSQL clinic CAS has one winner across locations and retains only public audit metadata", async () => {
  const first = { tenantId: `clinic-intake-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  const second = { ...first, locationId: "second" };
  const store = new PostgresClinicIntakeSettingStore(db);
  assert.deepEqual(await store.read(first), { ok: true, value: { version: "0", enabled: false } });
  const changes = await Promise.all([
    store.changeEnabled(first, "0", true, "owner-first"),
    store.changeEnabled(second, "0", false, "owner-second"),
  ]);
  assert.equal(changes.filter(row => row.ok).length, 1);
  assert.deepEqual(changes.filter(row => !row.ok), [{ ok: false, error: { kind: "versionConflict" } }]);
  const fromSecond = await new PostgresClinicIntakeSettingStore(db).read(second);
  assert.ok(fromSecond.ok);
  assert.equal(fromSecond.value.version, "1");
  assert.deepEqual(await store.read(first), fromSecond);
  assert.deepEqual(await store.read({ ...first, clinicId: "other" }), { ok: true, value: { version: "0", enabled: false } });
  assert.deepEqual(await store.read({ ...first, tenantId: "other" }), { ok: true, value: { version: "0", enabled: false } });
  assert.ok((await store.changeEnabled(second, "1", true, "owner-second")).ok);
  assert.ok((await store.changeEnabled(first, "2", false, "owner-first")).ok);
  assert.deepEqual(await store.read(second), { ok: true, value: { version: "3", enabled: false } });
  const history = await store.listChanges(second);
  assert.ok(history.ok);
  assert.equal(history.value.entries.length, 3);
  assert.equal(history.value.entries[1]?.previousEnabled, fromSecond.value.enabled);
  assert.equal(history.value.entries[2]?.previousEnabled, true);
  assert.ok(history.value.entries.every(row => Number.isFinite(Date.parse(row.changedAt))));
  const canary = "PATIENT_PRIVATE_INTAKE_SETTING_INPUT";
  assert.deepEqual(await store.changeEnabled(first, "3", canary as unknown as boolean, "owner"),
    { ok: false, error: { kind: "invalidValue" } });
  const stored = await sql<{ value: Record<string, unknown> }>`select to_jsonb(t) as value
    from clinic_intake_settings t where tenant_id = ${first.tenantId} order by version`.execute(db);
  assert.equal(stored.rows.length, 4);
  for (const row of stored.rows) {
    assert.deepEqual(Object.keys(row.value).sort(),
      ["tenant_id", "clinic_id", "version", "enabled", "previous_enabled", "changed_by", "changed_at"].sort());
    assert.equal(JSON.stringify(row.value).includes(canary), false);
  }
  await assert.rejects(sql`update clinic_intake_settings set changed_by = ' '
    where tenant_id = ${first.tenantId} and version = 3`.execute(db), /clinic_intake_settings_audit_check/);
  const opaque = { tenantId: `native/tenant ${randomUUID()}`, clinicId: "native/clinic 17" };
  assert.deepEqual(await store.changeEnabled(opaque, "0", true, "owner"),
    { ok: true, value: { version: "1", enabled: true } });
  assert.deepEqual(await new PostgresClinicIntakeSettingStore(db).read(opaque),
    { ok: true, value: { version: "1", enabled: true } });
});

test("E2E-255 SET-005 PostgreSQL audit pagination and rollback refuse dropping recorded history", async () => {
  const name = `abby_clinic_intake_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(process.env.DATABASE_URL!);
  target.pathname = `/${name}`;
  let created = false;
  let fresh: ReturnType<typeof connectPostgres> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(db);
    created = true;
    fresh = connectPostgres(target.toString());
    await migrate(fresh);
    const scope = { tenantId: "clinic-intake-pages", clinicId: "clinic" };
    const store = new PostgresClinicIntakeSettingStore(fresh);
    for (let version = 0; version < 51; version++) {
      assert.ok((await store.changeEnabled(scope, String(version), version % 2 === 0, "owner")).ok);
    }
    const page = await store.listChanges(scope);
    assert.ok(page.ok);
    assert.equal(page.value.entries.length, 50);
    assert.equal(page.value.nextAfterVersion, 50);
    const next = await store.listChanges(scope, page.value.nextAfterVersion);
    assert.ok(next.ok);
    assert.deepEqual(next.value.entries.map(row => row.version), ["51"]);
    assert.deepEqual(await store.listChanges(scope, -1), { ok: false, error: { kind: "invalidValue" } });
    await assert.rejects(migrateTo(fresh, "036_rescheduling_setting_audit"), /clinic intake setting history must be removed/);
    assert.deepEqual(await new PostgresClinicIntakeSettingStore(fresh).read(scope),
      { ok: true, value: { version: "51", enabled: true } });
  } finally {
    await fresh?.destroy();
    if (created) await sql.raw(`drop database "${name}" with (force)`).execute(db);
  }
});
