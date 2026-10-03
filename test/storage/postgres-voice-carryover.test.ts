import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { voiceClinicScope } from "../../src/core/voice-profile.ts";
import { materializeVerifiedArchive } from "../../src/portability/archive-envelope.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { ReferenceTenantConfigArchiveImporter } from "../../src/reference/tenant-config-archive-import.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresClinicVoiceSettingStore } from "../../src/storage/postgres-clinic-voice-settings.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { editSettingsArchive } from "../support/edit-settings-archive.ts";
import { voiceRegistry, value } from "../support/voice-settings-contract.ts";

assert.ok(process.env.DATABASE_URL); const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
const authority = { authorizeAndRecord: async () => ok({ auditRef: "reviewed-import" }) };
const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "reviewed-export" }) };
const mapper = { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` }, at = "2026-10-03T02:00:00.000Z";
async function fixture(twoLocations = true, mode: "standaloneMinimal" | "unsafeReference" = "standaloneMinimal") {
  const scope = { tenantId: `voice-source-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  const second = { ...scope, locationId: "second" }, target = { tenantId: `voice-target-${randomUUID()}`, clinicId: "buyer", locationId: "first" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, mode);
  value(await policy.changeBookingEnabled(scope, "0", false, "source-owner"));
  if (twoLocations) value(await policy.changeBookingEnabled(second, "0", false, "source-owner"));
  const raw = new PostgresClinicVoiceSettingStore(db, voiceRegistry()), clinic = voiceClinicScope(scope);
  value(await raw.change(clinic, "0", "locale", "en-AU", "source-owner"));
  value(await raw.change(clinic, "1", "voiceId", "coral", "source-owner"));
  value(await raw.change(clinic, "2", "locale", "en-US", "second-owner"));
  const request = { sourceTenantId: scope.tenantId, archiveId: `voice-archive-${randomUUID()}`, actorRef: "source-owner", createdAt: at,
    archiveMode: mode, locations: [{ sourceScope: scope, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
      ...(twoLocations ? [{ sourceScope: second, targetScope: { ...target, locationId: "second" }, timeZone: "UTC", mappingProvenance: "reviewed" }] : [])] };
  return { scope, second, target, raw, request, input: value(await buildPostgresTenantConfigArchive(db, request, exportAuthority)) };
}
for (const mode of ["standaloneMinimal", "unsafeReference"] as const) {
  test(`E2E-258 E2E-259 ${mode} exports one public voice history and separately clears target locale then voice`, async () => {
    const app = await fixture(true, mode), decoded = value(await decodeTenantConfigArchive(app.input, app.target.tenantId));
    assert.equal(decoded.clinics.length, 1); assert.equal(decoded.clinics[0]!.clinicVoice?.length, 4);
    const archive = value(await materializeVerifiedArchive(app.input));
    const rows = Buffer.from(archive.sections.settings).toString().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(row => row.kind === "clinicVoice");
    assert.equal(rows.length, 4);
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["recordVersion", "recordId", "sourceTenantId", "sourceClinicId", "kind", "version",
      "isHead", "locale", "voiceId", "settingKind", "value", "previousValue", "changedBy", "changedAt"].sort());
    const reference = value(await new ReferenceTenantConfigArchiveImporter(() => at).stage(app.input, app.target.tenantId, "buyer-owner", authority, mapper));
    const importer = new PostgresTenantConfigArchiveImporter(db, () => at, mode);
    value(await importer.stage(app.input, app.target.tenantId, "buyer-owner", authority, mapper));
    const durable = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, mode);
    for (const location of [app.target, { ...app.target, locationId: "second" }]) for (const store of [reference.policy, durable]) {
      const state = value(await store.read(location));
      assert.deepEqual(state.voiceSettings, { version: "5", locale: null, voiceId: null }); assert.equal(state.voiceProfile, undefined);
      assert.equal(state.automationEnabled, false); assert.equal(state.bookingEnabled, false);
    }
    const history = value(await reference.policy.listVoiceChanges(app.target));
    assert.deepEqual(history.entries.slice(0, 3), value(await app.raw.listChanges(voiceClinicScope(app.scope))).entries);
    assert.deepEqual(history.entries.slice(3).map(row => [row.version, row.kind, row.value, row.previousValue, row.changedAt]),
      [["4", "locale", null, "en-US", at], ["5", "voiceId", null, "coral", at]]);
    assert.deepEqual(value(await durable.listVoiceChanges({ ...app.target, locationId: "second" })), history);
    const retained = value(await importer.read(app.target.tenantId, "buyer-owner", authority)); assert.ok(retained);
    assert.deepEqual(retained.sourceHistory.clinics[0]!.clinicVoice, decoded.clinics[0]!.clinicVoice);
    value(await importer.stage(app.input, app.target.tenantId, "buyer-owner", authority, mapper));
    assert.equal((await sql<{ count: number }>`select count(*)::int as count from clinic_voice_settings where tenant_id = ${app.target.tenantId}`.execute(db)).rows[0]?.count, 6);
  });
}
test("E2E-258 E2E-259 single location and legacy archive absence have no executable target profile", async () => {
  const app = await fixture(false);
  const single = value(await new ReferenceConfigArchiveImporter(() => at).stage(app.input, app.target, "buyer-owner", authority, mapper));
  assert.deepEqual(value(await single.policy.read(app.target)).voiceSettings, { version: "5", locale: null, voiceId: null });
  const legacy = await editSettingsArchive(app.input, rows => rows.filter(row => row.kind !== "clinicVoice"));
  const reference = value(await new ReferenceTenantConfigArchiveImporter(() => at).stage(legacy, app.target.tenantId, "buyer-owner", authority, mapper));
  value(await new PostgresTenantConfigArchiveImporter(db).stage(legacy, app.target.tenantId, "buyer-owner", authority, mapper));
  for (const store of [reference.policy, new PostgresPolicyStore(db, referenceDefaultPolicy)]) {
    assert.deepEqual(value(await store.read(app.target)).voiceSettings, { version: "0", locale: null, voiceId: null });
    assert.equal(value(await store.read(app.target)).voiceProfile, undefined); assert.deepEqual(value(await store.listVoiceChanges(app.target)), { entries: [] });
  }
});
test("E2E-258 E2E-259 resealed missing expanded or contradictory public histories reject before target writes", async () => {
  const app = await fixture(false), isVoice = (row: Record<string, unknown>) => row.kind === "clinicVoice" && row.version === 2;
  const edits = [
    (rows: Record<string, unknown>[]) => rows.filter(row => !isVoice(row)),
    (rows: Record<string, unknown>[]) => rows.map(row => isVoice(row) ? { ...row, configurationHash: "a".repeat(64) } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => isVoice(row) ? { ...row, locale: "en-US" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => isVoice(row) ? { ...row, previousValue: "cedar" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => isVoice(row) ? { ...row, changedBy: " " } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => isVoice(row) ? { ...row, changedAt: "invalid" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => isVoice(row) ? { ...row, isHead: true } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "locationPolicy" ? { ...row, policy: { ...row.policy as object, voiceProfile: { hostVersion: "forged" } } } : row),
  ];
  for (const edit of edits) {
    const invalid = await editSettingsArchive(app.input, edit), expected = { ok: false, error: { kind: "invalidConfigArchive", section: "settings" } };
    assert.deepEqual(await decodeTenantConfigArchive(invalid, app.target.tenantId), expected);
    assert.deepEqual(await new PostgresTenantConfigArchiveImporter(db).stage(invalid, app.target.tenantId, "buyer-owner", authority, mapper), expected);
  }
  assert.equal((await sql<{ count: number }>`select count(*)::int as count from clinic_voice_settings where tenant_id = ${app.target.tenantId}`.execute(db)).rows[0]?.count, 0);
});
test("E2E-258 E2E-259 source freeze blocks setting clears raw writes and truncate; unlisted source clinics cannot vanish", async () => {
  const app = await fixture(false);
  value(await new PostgresPortabilityFence(db).freeze({ tenantId: app.scope.tenantId, actorRef: "owner", reason: "cutoverFreeze" }, exportAuthority));
  for (const kind of ["locale", "voiceId"] as const) {
    assert.deepEqual(await app.raw.change(voiceClinicScope(app.scope), "3", kind, null, "owner"), { ok: false, error: { kind: "storageFailure" } });
  }
  await assert.rejects(sql`delete from clinic_voice_settings where tenant_id = ${app.scope.tenantId}`.execute(db), /fence active/);
  await assert.rejects(sql`update clinic_voice_settings set changed_by = 'forged-owner' where tenant_id = ${app.scope.tenantId} and version = 1`.execute(db), /fence active/);
  await assert.rejects(sql`truncate clinic_voice_settings`.execute(db), /truncate bypasses/);
  assert.equal(value(await app.raw.read(voiceClinicScope(app.scope))).version, "3");
  const other = await fixture(false);
  value(await other.raw.change({ tenantId: other.scope.tenantId, clinicId: "unlisted" }, "0", "locale", "en-AU", "owner"));
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, { ...other.request, archiveId: `incomplete-${randomUUID()}` }, exportAuthority),
    { ok: false, error: { kind: "scopeIncomplete" } });
});
test("E2E-258 E2E-259 existing target voice preferences block import without replacing their history", async () => {
  const app = await fixture(false), target = voiceClinicScope(app.target);
  value(await app.raw.change(target, "0", "locale", "en-AU", "target-owner"));
  const before = await app.raw.listChanges(target);
  const result = await new PostgresTenantConfigArchiveImporter(db).stage(app.input, app.target.tenantId, "buyer-owner", authority, mapper);
  assert.ok(!result.ok && result.error.kind === "targetOccupied"); assert.deepEqual(await app.raw.listChanges(target), before);
});

test("E2E-258 E2E-259 partial source setup adds only its locale clear and canonical UTC audit is shared by both targets", async () => {
  const app = await fixture(false);
  const partial = await editSettingsArchive(app.input, rows => rows.filter(row => row.kind !== "clinicVoice" || Number(row.version) <= 1)
    .map(row => row.kind === "clinicVoice" && row.version === 1 ? { ...row, isHead: true, changedAt: at.replace(".000Z", "Z") } : row));
  const reference = value(await new ReferenceTenantConfigArchiveImporter(() => at).stage(partial, app.target.tenantId, "buyer-owner", authority, mapper));
  value(await new PostgresTenantConfigArchiveImporter(db, () => at).stage(partial, app.target.tenantId, "buyer-owner", authority, mapper));
  const durable = new PostgresPolicyStore(db, referenceDefaultPolicy);
  const expected = value(await reference.policy.listVoiceChanges(app.target));
  assert.deepEqual(expected.entries.map(row => [row.version, row.kind, row.value, row.previousValue, row.changedAt]),
    [["1", "locale", "en-AU", null, at], ["2", "locale", null, "en-AU", at]]);
  assert.deepEqual(value(await durable.listVoiceChanges(app.target)), expected);
  for (const store of [reference.policy, durable]) {
    const state = value(await store.read(app.target));
    assert.deepEqual(state.voiceSettings, { version: "2", locale: null, voiceId: null }); assert.equal(state.voiceProfile, undefined);
  }
});
