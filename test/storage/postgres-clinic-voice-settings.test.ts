import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { defaultVoicePreferences } from "../../src/core/voice-profile.ts";
import { ok } from "../../src/core/model.ts";
import { captureVoiceProfile } from "../../src/core/voice-profile-registry.ts";
import type { VoiceProfileRegistry } from "../../src/core/voice-profile-registry.ts";
import { PostgresClinicVoiceSettingStore } from "../../src/storage/postgres-clinic-voice-settings.ts";
import { PostgresClinicNotificationSettingStore } from "../../src/storage/postgres-clinic-notification-settings.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";
import { voicePolicyMutationContract, voiceDeclaration, voiceRegistry, voiceScope, voiceSettingsContract, value } from "../support/voice-settings-contract.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
voiceSettingsContract("PostgreSQL", registry => new PostgresClinicVoiceSettingStore(db, registry));
test("E2E-258 E2E-259 public preferences survive reconnect and competing connections share one CAS", async () => {
  const scope = voiceScope(), first = new PostgresClinicVoiceSettingStore(db, voiceRegistry());
  assert.ok((await first.change(scope, "0", "locale", "en-AU", "first-owner")).ok);
  const secondDb = connectPostgres(process.env.DATABASE_URL!);
  try {
    const second = new PostgresClinicVoiceSettingStore(secondDb, voiceRegistry());
    assert.deepEqual(await second.read(scope), await first.read(scope));
    assert.ok((await second.change(scope, "1", "voiceId", "coral", "second-owner")).ok);
    const admitted = value(await captureVoiceProfile(voiceRegistry(), scope, value(await second.read(scope))));
    const edits = await Promise.all([first.change(scope, "2", "locale", "en-US", "first-owner"),
      second.change(scope, "2", "voiceId", "cedar", "second-owner")]);
    assert.equal(edits.filter(result => result.ok).length, 1);
    assert.deepEqual(edits.find(result => !result.ok), { ok: false, error: { kind: "versionConflict" } });
    assert.equal(admitted.settingsVersion, "2"); assert.equal(admitted.locale, "en-AU"); assert.equal(admitted.voiceId, "coral");
    assert.equal(value(await first.listChanges(scope)).entries.length, 3);
    const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'clinic_voice_settings' order by column_name`.execute(db);
    assert.deepEqual(columns.rows.map(row => row.column_name), ["changed_at", "changed_by", "clinic_id", "locale",
      "previous_value", "setting_kind", "setting_value", "tenant_id", "version", "voice_id"]);
  } finally { await secondDb.destroy(); }
});
test("E2E-258 E2E-259 pair preflight cannot commit after in-place counterpart tampering", async () => {
  const scope = voiceScope(), initial = new PostgresClinicVoiceSettingStore(db, voiceRegistry());
  assert.ok((await initial.change(scope, "0", "locale", "en-AU", "owner")).ok);
  assert.ok((await initial.change(scope, "1", "voiceId", "coral", "owner")).ok);
  const registry: VoiceProfileRegistry = { resolve: async bound => {
    await sql`update clinic_voice_settings set locale = 'en-US'
      where tenant_id = ${bound.tenantId} and clinic_id = ${bound.clinicId} and version = 2`.execute(db);
    return ok(voiceDeclaration(bound));
  } };
  const changed = await new PostgresClinicVoiceSettingStore(db, registry).change(scope, "2", "voiceId", "cedar", "owner");
  assert.deepEqual(changed, { ok: false, error: { kind: "storageFailure" } });
  assert.equal(value(await initial.read(scope)).version, "2");
  assert.equal(value(await initial.listChanges(scope)).entries.length, 2);
});
test("E2E-258 E2E-259 migration upgrades populated public history and refuses voice-history rollback", async () => {
  const databaseName = `voice_upgrade_${randomUUID().replaceAll("-", "")}`;
  await sql`create database ${sql.id(databaseName)}`.execute(db);
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${databaseName}`;
  const upgraded = connectPostgres(url.toString());
  try {
    await migrateTo(upgraded, "039_clinic_notification_settings");
    const scope = voiceScope();
    const notifications = new PostgresClinicNotificationSettingStore(upgraded);
    assert.ok((await notifications.changeOwner({ ...scope, locationId: "main" }, "0", "bookingConfirmation", null, "old-owner")).ok);
    const before = await notifications.listChanges(scope);
    await migrate(upgraded);
    assert.deepEqual(await notifications.listChanges(scope), before);
    const voices = new PostgresClinicVoiceSettingStore(upgraded, voiceRegistry());
    assert.ok((await voices.change(scope, "0", "locale", "en-AU", "owner")).ok);
    const saved = await voices.read(scope);
    await assert.rejects(() => migrate(upgraded, "down"), /clinic voice setting history must be removed/);
    assert.deepEqual(await voices.read(scope), saved);
    assert.deepEqual(await notifications.listChanges(scope), before);
  } finally {
    await upgraded.destroy();
    await sql`drop database ${sql.id(databaseName)}`.execute(db);
  }
});

for (const mode of ["standaloneMinimal", "unsafeReference"] as const) {
  test(`E2E-258 E2E-259 ${mode} policy derives public speech authority from clinic preferences across locations`, async () => {
    const scope = { ...voiceScope(), locationId: "first" }, second = { ...scope, locationId: "second" };
    const defaults = (bound: typeof scope) => ({ ...referenceDefaultPolicy(bound),
      voiceSettings: { version: "999", locale: "en-US", voiceId: "cedar" }, voiceProfile: {} as never });
    const policy = new PostgresPolicyStore(db, defaults, undefined, undefined, false, mode, false,
      undefined, undefined, undefined, voiceRegistry());
    const initial = value(await policy.read(scope));
    assert.deepEqual(initial.voiceSettings, defaultVoicePreferences()); assert.equal(initial.voiceProfile, undefined);
    assert.ok((await policy.changeVoiceSetting(scope, "0", "locale", "en-AU", "voice-owner")).ok);
    const admitted = value(await policy.changeVoiceSetting(second, "1", "voiceId", "coral", "voice-owner"));
    assert.equal(admitted.voiceProfile?.settingsVersion, "2"); assert.equal(admitted.voiceProfile?.voiceId, "coral");
    assert.equal(admitted.capabilities.book, "unavailable"); assert.equal(admitted.capabilities.cancel, "unavailable");
    assert.equal(admitted.automationEnabled, false); assert.equal(admitted.policyVersion, "0");
    assert.ok((await policy.changeBookingEnabled(scope, "0", true, "location-owner")).ok);
    assert.equal(value(await policy.read(scope)).voiceSettings?.version, "2");
    assert.equal(value(await policy.read(second)).policyVersion, "0");
    assert.ok((await policy.changeVoiceSetting(scope, "2", "voiceId", "cedar", "voice-owner")).ok);
    assert.deepEqual(await policy.changeVoiceSetting(second, "2", "locale", "en-US", "stale-owner"),
      { ok: false, error: { kind: "versionConflict" } });
    assert.equal(admitted.voiceProfile?.voiceId, "coral");
    assert.equal(value(await policy.read(second)).voiceProfile?.voiceId, "cedar");
    assert.ok((await policy.changeVoiceSetting(second, "3", "locale", null, "voice-owner")).ok);
    assert.equal(value(await policy.read(scope)).voiceProfile, undefined);
    assert.equal(value(await policy.listVoiceChanges(second)).entries.length, 4);
    const rows = await sql<{ policy: Record<string, unknown> }>`select policy from clinic_settings where tenant_id = ${scope.tenantId}`.execute(db);
    for (const row of rows.rows) for (const field of ["voiceSettings", "voiceProfile"]) assert.equal(Object.hasOwn(row.policy, field), false);
    const other = { ...scope, clinicId: "other" };
    assert.deepEqual(value(await policy.read(other)).voiceSettings, defaultVoicePreferences());
    // A forged location row never substitutes for the separately versioned clinic authority.
    await sql`update clinic_settings set policy = policy || ${JSON.stringify({ voiceSettings: admitted.voiceSettings, voiceProfile: admitted.voiceProfile })}::jsonb
      where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId} and location_id = ${scope.locationId}`.execute(db);
    assert.deepEqual(await policy.read(scope), { ok: false, error: { kind: "storageFailure" } });
  });
}

for (const mode of ["standaloneMinimal", "unsafeReference"] as const) {
  voicePolicyMutationContract(`PostgreSQL ${mode}`, registry => new PostgresPolicyStore(db, referenceDefaultPolicy,
    undefined, undefined, false, mode, false, undefined, undefined, undefined, registry));
}
