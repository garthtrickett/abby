import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresClinicNotificationSettingStore } from "../../src/storage/postgres-clinic-notification-settings.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { defaultNotificationSettings } from "../../src/core/notification-policy.ts";
import { PostgresClinicIntakeSettingStore } from "../../src/storage/postgres-clinic-intake-setting.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";
import { notificationRegistry, notificationSettingsContract } from "../support/notification-settings-contract.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
notificationSettingsContract("E2E-257 PostgreSQL", registry => new PostgresClinicNotificationSettingStore(db, registry));

test("E2E-257 PostgreSQL notification preferences survive reconnection but cannot grant standalone send authority", async () => {
  const first = { tenantId: `notification-minimal-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  const raw = new PostgresClinicNotificationSettingStore(db, notificationRegistry());
  assert.ok((await raw.changeOwner(first, "0", "bookingConfirmation", "abby", "owner")).ok);
  const second = { ...first, locationId: "second" };
  const fromSecond = await new PostgresClinicNotificationSettingStore(db).read(second);
  assert.ok(fromSecond.ok);
  assert.equal(fromSecond.value.owners.bookingConfirmation, "abby");
  const defaults = (scope: typeof first) => ({ ...referenceDefaultPolicy(scope),
    notificationSettings: { ...defaultNotificationSettings(), version: "999" },
    notificationBindings: { bookingConfirmation: { scope, kind: "bookingConfirmation" as const, owner: "abby" as const,
      settingsVersion: "999", hostVersion: "forged-host" } } });
  const minimal = new PostgresPolicyStore(db, defaults, undefined, undefined, false,
    "standaloneMinimal", false, undefined, undefined, notificationRegistry());
  const read = await minimal.read(first);
  assert.ok(read.ok);
  assert.equal(read.value.notificationSettings?.version, "1");
  assert.equal(read.value.notificationSettings?.owners.bookingConfirmation, "abby");
  assert.deepEqual(read.value.notificationBindings, {});
  assert.deepEqual(await minimal.changeNotificationOwner(first, "1", "bookingConfirmation", "host", "owner"),
    { ok: false, error: { kind: "readinessFailed", missing: ["notificationOwner"] } });
  assert.ok((await minimal.changeNotificationOwner(first, "1", "bookingConfirmation", null, "owner")).ok);
  const embedded = new PostgresPolicyStore(db, referenceDefaultPolicy, undefined, undefined, false,
    "unsafeReference", false, undefined, undefined, notificationRegistry());
  const configured = await embedded.changeNotificationOwner(first, "2", "bookingConfirmation", "host", "owner");
  assert.ok(configured.ok);
  assert.equal(configured.value.notificationBindings?.bookingConfirmation?.owner, "host");
  const publicPolicies = await sql<{ policy: Record<string, unknown> }>`select policy from clinic_settings
    where tenant_id = ${first.tenantId}`.execute(db);
  for (const row of publicPolicies.rows) {
    assert.equal(Object.hasOwn(row.policy, "notificationSettings"), false);
    assert.equal(Object.hasOwn(row.policy, "notificationBindings"), false);
  }
  const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_notification_settings' order by column_name`.execute(db);
  assert.deepEqual(columns.rows.map(row => row.column_name),
    ["changed_at", "changed_by", "clinic_id", "notification_kind", "owner", "owners", "previous_owner", "tenant_id", "version"]);
});

test("E2E-257 notification migration upgrades populated schema and refuses to discard recorded clinic history", async () => {
  const databaseName = `notification_upgrade_${randomUUID().replaceAll("-", "")}`;
  await sql`create database ${sql.id(databaseName)}`.execute(db);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${databaseName}`;
  const upgraded = connectPostgres(url.toString());
  try {
    await migrateTo(upgraded, "038_staffed_destination_setting_audit");
    const scope = { tenantId: "populated-notification-upgrade", clinicId: "clinic", locationId: "main" };
    const intake = new PostgresClinicIntakeSettingStore(upgraded);
    assert.ok((await intake.changeEnabled(scope, "0", true, "old-owner")).ok);
    const before = await intake.listChanges(scope);
    await migrate(upgraded);
    assert.deepEqual(await intake.listChanges(scope), before);
    const notifications = new PostgresClinicNotificationSettingStore(upgraded, notificationRegistry());
    assert.deepEqual(await notifications.read(scope), { ok: true, value: defaultNotificationSettings() });
    assert.ok((await notifications.changeOwner(scope, "0", "bookingConfirmation", "host", "owner")).ok);
    const stored = await notifications.read(scope);
    await assert.rejects(() => migrate(upgraded, "down"), /clinic notification setting history must be removed/);
    assert.deepEqual(await notifications.read(scope), stored);
    assert.deepEqual(await intake.listChanges(scope), before);
  } finally {
    await upgraded.destroy();
    await sql`drop database ${sql.id(databaseName)}`.execute(db);
  }
});
