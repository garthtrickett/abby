import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { ReferenceTenantConfigArchiveImporter } from "../../src/reference/tenant-config-archive-import.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { comparePostgresConfigArchiveSource } from "../../src/storage/postgres-config-archive-drift.ts";
import { reconcilePatientCorrectionCarryover } from "../../src/storage/postgres-patient-correction-carryover.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";
import { targetReady } from "../../src/storage/postgres-cutover-target.ts";
import type { TargetImportRow } from "../../src/storage/postgres-cutover-target.ts";
import { editSettingsArchive } from "../support/edit-settings-archive.ts";
import { value } from "../support/voice-settings-contract.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
const authority = { authorizeAndRecord: async () => ok({ auditRef: "synthetic-buyer-audit" }) };
const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "synthetic-source-audit" }) };
const mapper = { mapRef: () => "disabled" }, importedAt = "2026-10-13T21:00:00.000Z";

async function fixture(locations = 1, finalEnabled = true) {
  const id = randomUUID(), source = { tenantId: `correction-export-${id}`, clinicId: "clinic", locationId: "first" };
  const target = { tenantId: `correction-import-${id}`, clinicId: "buyer", locationId: "first" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy);
  for (const [version, enabled] of [true, false, finalEnabled].entries()) {
    value(await policy.changePatientCorrectionsEnabled(source, String(version), enabled, "synthetic-source-owner"));
  }
  const request = { sourceTenantId: source.tenantId, archiveId: `correction-archive-${id}`, actorRef: "synthetic-source-owner",
    createdAt: "2026-10-13T20:00:00.000Z", locations: Array.from({ length: locations }, (_, i) => ({
      sourceScope: { ...source, locationId: i ? "second" : "first" }, targetScope: { ...target, locationId: i ? "second" : "first" },
      timeZone: "UTC", mappingProvenance: "reviewed" })) };
  const archive = value(await buildPostgresTenantConfigArchive(db, request, exportAuthority));
  const data = value(await decodeTenantConfigArchive(archive, target.tenantId));
  return { source, target, policy, request, archive, data };
}

test("E2E-368 correction settings carry one shared audit and target disable through reference and PostgreSQL imports", async () => {
  const f = await fixture(2), importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt);
  assert.equal(f.data.clinics.length, 1); assert.equal(f.data.clinics[0]!.clinicPatientCorrections!.length, 4);
  const reference = value(await new ReferenceTenantConfigArchiveImporter(() => importedAt).stage(f.archive, f.target.tenantId, "buyer-owner", authority, mapper));
  const staged = value(await importer.stage(f.archive, f.target.tenantId, "buyer-owner", authority, mapper));
  const durable = new PostgresPolicyStore(db, referenceDefaultPolicy);
  for (const { targetScope } of f.request.locations) {
    for (const store of [reference.policy, durable]) {
      const current = value(await store.read(targetScope));
      assert.equal(current.patientCorrectionsEnabled, false); assert.equal(current.patientCorrectionsVersion, "4");
      assert.equal(current.capabilities.patientUpdate, "unavailable");
    }
  }
  const history = value(await durable.listPatientCorrectionChanges(f.target));
  assert.deepEqual(history, value(await reference.policy.listPatientCorrectionChanges(f.target)));
  assert.deepEqual(history.entries.map(row => [row.version, row.enabled, row.previousEnabled]),
    [["1", true, false], ["2", false, true], ["3", true, false], ["4", false, true]]);
  assert.equal(history.entries.at(-1)!.changedAt, importedAt);
  const retained = value(await importer.read(f.target.tenantId, "buyer-owner", authority)); assert.ok(retained);
  assert.deepEqual(retained.sourceHistory.clinics[0]!.clinicPatientCorrections, f.data.clinics[0]!.clinicPatientCorrections);
  assert.deepEqual(value(await importer.stage(f.archive, f.target.tenantId, "buyer-owner", authority, mapper)), staged);
  const count = await sql<{ count: number }>`select count(*)::int as count from clinic_patient_correction_settings where tenant_id = ${f.target.tenantId}`.execute(db);
  assert.equal(count.rows[0]!.count, 5, "locations share one clinic history and import retry adds no disable");
});

test("E2E-368 disabled and legacy correction settings stay disabled without invented audit events", async () => {
  const f = await fixture(1, false);
  const single = value(await new ReferenceConfigArchiveImporter(() => importedAt).stage(f.archive, f.target, "buyer-owner", authority, mapper));
  assert.equal(value(await single.policy.read(f.target)).patientCorrectionsVersion, "3");
  assert.equal(value(await single.policy.listPatientCorrectionChanges(f.target)).entries.length, 3);
  const legacy = await editSettingsArchive(f.archive, rows => rows.filter(row => row.kind !== "clinicPatientCorrections"));
  const reference = value(await new ReferenceTenantConfigArchiveImporter(() => importedAt).stage(legacy, f.target.tenantId, "buyer-owner", authority, mapper));
  const importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt);
  value(await importer.stage(legacy, f.target.tenantId, "buyer-owner", authority, mapper));
  for (const store of [reference.policy, new PostgresPolicyStore(db, referenceDefaultPolicy)]) {
    const current = value(await store.read(f.target));
    assert.equal(current.patientCorrectionsVersion, "0"); assert.equal(current.patientCorrectionsEnabled, false);
    assert.deepEqual(value(await store.listPatientCorrectionChanges(f.target)), { entries: [] });
  }
});

test("E2E-368 resealed broken/private histories and omitted or occupied correction-only clinics are refused", async () => {
  const f = await fixture(), importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt);
  for (const edit of [
    (rows: Record<string, unknown>[]) => rows.filter(row => row.kind !== "clinicPatientCorrections" || row.version !== 1),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "clinicPatientCorrections" && row.version === 2 ? { ...row, previousEnabled: false } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "clinicPatientCorrections" && row.version === 1 ? { ...row, isHead: true } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "clinicPatientCorrections" ? { ...row, patientNotes: "PRIVATE_CORRECTION_ARCHIVE_CANARY" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "clinicPatientCorrections" && row.version === 1 ? { ...row, changedBy: " " } : row),
  ]) {
    const invalid = await editSettingsArchive(f.archive, edit);
    const expected = { ok: false, error: { kind: "invalidConfigArchive", section: "settings" } };
    assert.deepEqual(await decodeTenantConfigArchive(invalid, f.target.tenantId), expected);
    assert.deepEqual(await importer.preflight(invalid, f.target.tenantId, "buyer-owner", authority, mapper), expected);
  }
  value(await f.policy.changePatientCorrectionsEnabled(f.target, "0", false, "target-owner"));
  assert.deepEqual(await importer.preflight(f.archive, f.target.tenantId, "buyer-owner", authority, mapper), { ok: false, error: { kind: "targetOccupied" } });
  value(await f.policy.changePatientCorrectionsEnabled({ ...f.source, clinicId: "omitted" }, "0", true, "source-owner"));
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, f.request, exportAuthority), { ok: false, error: { kind: "scopeIncomplete" } });
  await sql`delete from clinic_patient_correction_settings where tenant_id = ${f.source.tenantId} and clinic_id = 'omitted'`.execute(db);
  await sql`update clinic_patient_correction_settings set previous_enabled = false where tenant_id = ${f.source.tenantId} and version = 2`.execute(db);
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, f.request, exportAuthority), { ok: false, error: { kind: "storageCorrupt" } });
});

test("E2E-368 reference-profile target reconciliation detects correction audit edits and unlisted correction-only target clinics", async () => {
  const f = await fixture(), importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt, "unsafeReference");
  value(await importer.stage(f.archive, f.target.tenantId, "buyer-owner", authority, mapper));
  const registry = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history from tenant_config_imports
    where target_tenant_id = ${f.target.tenantId}`.execute(db)).rows[0]!;
  const ready = () => db.transaction().execute(trx => targetReady(trx, f.data, registry));
  assert.equal(await ready(), true);
  await sql`update clinic_patient_correction_settings set changed_at = '2026-10-13T21:01:00Z' where tenant_id = ${f.target.tenantId} and version = 4`.execute(db);
  assert.equal(await ready(), false);
  await sql`update clinic_patient_correction_settings set changed_at = ${importedAt}::timestamptz where tenant_id = ${f.target.tenantId} and version = 4`.execute(db);
  assert.equal(await ready(), true);
  await sql`insert into clinic_patient_correction_settings (tenant_id, clinic_id, version, enabled) values (${f.target.tenantId}, 'unlisted', 0, false)`.execute(db);
  assert.equal(await ready(), false);
});


test("E2E-368 source drift comparison includes the independently versioned correction preference", async () => {
  const f = await fixture();
  value(await f.policy.changePatientCorrectionsEnabled(f.source, "3", false, "synthetic-source-owner"));
  const changed = value(await comparePostgresConfigArchiveSource(db, f.archive, {
    scope: f.source, targetScope: f.target, archiveId: `comparison-${randomUUID()}`, actorRef: "source-owner",
    createdAt: "2026-10-13T20:30:00.000Z", timeZone: "UTC", mappingProvenance: "reviewed",
  }, exportAuthority));
  assert.equal(changed.kind, "changed"); assert.deepEqual(changed.changed, ["settings"]);
});


test("E2E-368 archive timestamp variants retain the same audit instants in memory and PostgreSQL", async () => {
  const f = await fixture();
  const archive = await editSettingsArchive(f.archive, rows => rows.map(row => row.kind === "clinicPatientCorrections" && typeof row.changedAt === "string"
    ? { ...row, changedAt: "2026-10-13T20:00:00Z" } : row));
  const reference = value(await new ReferenceTenantConfigArchiveImporter(() => importedAt).stage(archive, f.target.tenantId, "buyer-owner", authority, mapper));
  value(await new PostgresTenantConfigArchiveImporter(db, () => importedAt).stage(archive, f.target.tenantId, "buyer-owner", authority, mapper));
  const durable = value(await new PostgresPolicyStore(db, referenceDefaultPolicy).listPatientCorrectionChanges(f.target));
  assert.deepEqual(durable, value(await reference.policy.listPatientCorrectionChanges(f.target)));
  assert.deepEqual(durable.entries.slice(0, 3).map(row => row.changedAt), Array(3).fill("2026-10-13T20:00:00.000Z"));
});


test("E2E-368 old implicit disabled targets reconcile without history while corrupted retained history is unreadable", async () => {
  const f = await fixture();
  assert.equal(await db.transaction().execute(trx => reconcilePatientCorrectionCarryover(trx, f.target, undefined, "import-owner", importedAt)), 0);
  const importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt);
  value(await importer.stage(f.archive, f.target.tenantId, "buyer-owner", authority, mapper));
  const data = structuredClone(f.data), clinic = data.clinics[0]!;
  const corrupted = { ...clinic, clinicPatientCorrections: clinic.clinicPatientCorrections!.map(row => row.version === 1
    ? { ...row, patientNotes: "PRIVATE_RETAINED_CORRECTION_CANARY" } : row) };
  await sql`update tenant_config_imports set source_history = ${JSON.stringify({ ...data, clinics: [corrupted] })}::jsonb
    where target_tenant_id = ${f.target.tenantId}`.execute(db);
  assert.deepEqual(await importer.read(f.target.tenantId, "buyer-owner", authority), { ok: false, error: { kind: "storageFailure" } });
});


test("E2E-368 upgraded correction settings cannot change or lose their guards during a frozen migration", async () => {
  await withDisposablePostgres(async isolated => {
    const scope = { tenantId: "correction-frozen", clinicId: "clinic", locationId: "main" };
    // Exercise the upgrade over existing history, rather than only a fresh table.
    await migrateTo(isolated, "045_cliniko_contact_change_registry");
    const policy = new PostgresPolicyStore(isolated, referenceDefaultPolicy);
    value(await policy.changePatientCorrectionsEnabled(scope, "0", true, "source-owner"));
    await migrate(isolated);
    const fence = new PostgresPortabilityFence(isolated);
    const authorized = { authorizeAndRecord: async () => ok({ requestRef: randomUUID() }) };
    const frozen = value(await fence.freeze({ tenantId: scope.tenantId, actorRef: "source-owner", reason: "cutoverFreeze" }, authorized));
    assert.equal((await policy.changePatientCorrectionsEnabled(scope, "1", false, "source-owner")).ok, false);
    await assert.rejects(sql`update clinic_patient_correction_settings set enabled = false where tenant_id = ${scope.tenantId} and version = 1`.execute(isolated), /portability fence active/);
    await assert.rejects(sql`delete from clinic_patient_correction_settings where tenant_id = ${scope.tenantId}`.execute(isolated), /portability fence active/);
    await assert.rejects(sql`truncate clinic_patient_correction_settings`.execute(isolated), /truncate bypasses tenant portability fences/);
    await assert.rejects(migrateTo(isolated, "045_cliniko_contact_change_registry"), /cannot remove correction portability guards/);
    assert.equal(value(await policy.read(scope)).patientCorrectionsVersion, "1");
    assert.equal(value(await policy.listPatientCorrectionChanges(scope)).entries.length, 1);
    value(await fence.release({ tenantId: scope.tenantId, actorRef: "source-owner", reason: "cutoverRelease", expectedVersion: frozen.version }, authorized));
    assert.equal(value(await policy.changePatientCorrectionsEnabled(scope, "1", false, "source-owner")).patientCorrectionsVersion, "2");
    await migrateTo(isolated, "045_cliniko_contact_change_registry"); await migrate(isolated);
    assert.equal(value(await policy.listPatientCorrectionChanges(scope)).entries.length, 2);
  });
});
