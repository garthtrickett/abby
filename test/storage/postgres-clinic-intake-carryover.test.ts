import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { materializeVerifiedArchive } from "../../src/portability/archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../../src/portability/archive-envelope.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { ReferenceTenantConfigArchiveImporter } from "../../src/reference/tenant-config-archive-import.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
const authority = { authorizeAndRecord: async () => ok({ auditRef: "buyer-audit" }) };
const mapper = { mapRef: () => "disabled" };
const importedAt = "2026-10-02T17:00:00.000Z";

// Recompute the envelope so these cases exercise semantic validation, rather than only checksum rejection.
async function editSettings(input: ArchiveEnvelope, edit: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<ArchiveEnvelope> {
  const result = await materializeVerifiedArchive(input);
  assert.ok(result.ok);
  const parts = { ...result.value.sections };
  const rows = Buffer.from(parts.settings).toString().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const next = edit(rows);
  parts.settings = Buffer.from(next.map(row => JSON.stringify(row)).join("\n") + "\n");
  const manifest = JSON.parse(Buffer.from(result.value.manifestBytes).toString()) as {
    sections: Record<string, { recordCount: number; byteCount: number; sha256: string }>;
  };
  manifest.sections.settings = { ...manifest.sections.settings, recordCount: next.length, byteCount: parts.settings.byteLength,
    sha256: createHash("sha256").update(parts.settings).digest("hex") };
  const section = (name: ArchiveSection) => async function* () { yield parts[name]; };
  return { manifestBytes: Buffer.from(JSON.stringify(manifest)), sections: {
    locations: section("locations"), settings: section("settings"), knowledge: section("knowledge"),
    calls: section("calls"), staffWork: section("staffWork"),
  } };
}

test("E2E-255 clinic intake archive carries one shared history and one audited target disable across locations", async () => {
  const suffix = randomUUID();
  const first = { tenantId: `intake-source-${suffix}`, clinicId: "clinic", locationId: "first" };
  const second = { ...first, locationId: "second" };
  const target = { tenantId: `intake-target-${suffix}`, clinicId: "buyer", locationId: "first" };
  const targetSecond = { ...target, locationId: "second" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy);
  assert.ok((await policy.changeBookingEnabled(first, "0", true, "source-owner")).ok);
  for (let version = 0; version < 3; version++) {
    assert.ok((await policy.changeFirstTimeIntakeEnabled(version % 2 ? second : first,
      String(version), version % 2 === 0, "source-owner")).ok);
  }
  const exported = await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: first.tenantId, archiveId: `intake-archive-${suffix}`, actorRef: "source-owner",
    createdAt: "2026-10-02T16:00:00.000Z", locations: [
      { sourceScope: first, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
      { sourceScope: second, targetScope: targetSecond, timeZone: "UTC", mappingProvenance: "reviewed" },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "source-audit" }) });
  assert.ok(exported.ok);
  const decoded = await decodeTenantConfigArchive(exported.value, target.tenantId);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.clinics.length, 1);
  assert.equal(decoded.value.clinics[0]?.clinicIntake?.length, 4);
  assert.equal(decoded.value.sectionManifests.settings.recordCount, 7);
  for (const location of decoded.value.locations) {
    assert.ok(location.policies.every(row => !Object.hasOwn(row.policy, "firstTimeIntakeEnabled") &&
      !Object.hasOwn(row.policy, "firstTimeIntakeVersion")));
  }
  const reference = await new ReferenceTenantConfigArchiveImporter(() => importedAt).stage(
    exported.value, target.tenantId, "buyer-owner", authority, mapper);
  assert.ok(reference.ok);
  for (const scope of [target, targetSecond]) {
    const current = await reference.value.policy.read(scope);
    assert.ok(current.ok);
    assert.equal(current.value.firstTimeIntakeEnabled, false);
    assert.equal(current.value.firstTimeIntakeVersion, "4");
    assert.equal(current.value.capabilities.intake, "unavailable");
  }
  const referenceHistory = await reference.value.policy.listFirstTimeIntakeChanges(target);
  assert.ok(referenceHistory.ok);
  const importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt);
  const staged = await importer.stage(exported.value, target.tenantId, "buyer-owner", authority, mapper);
  assert.ok(staged.ok);
  const durableHistory = await new PostgresPolicyStore(db, referenceDefaultPolicy).listFirstTimeIntakeChanges(targetSecond);
  assert.ok(durableHistory.ok);
  assert.deepEqual(durableHistory.value, referenceHistory.value);
  assert.deepEqual(durableHistory.value.entries.map(row => [row.version, row.enabled, row.previousEnabled]),
    [["1", true, false], ["2", false, true], ["3", true, false], ["4", false, true]]);
  assert.equal(durableHistory.value.entries.at(-1)?.changedAt, importedAt);
  const retained = await new PostgresTenantConfigArchiveImporter(db).read(target.tenantId, "buyer-owner", authority);
  assert.ok(retained.ok && retained.value);
  assert.deepEqual(retained.value.sourceHistory.clinics[0]?.clinicIntake, decoded.value.clinics[0]?.clinicIntake);
  assert.ok((await importer.stage(exported.value, target.tenantId, "buyer-owner", authority, mapper)).ok);
  const count = await sql<{ count: number }>`select count(*)::int as count from clinic_intake_settings
    where tenant_id = ${target.tenantId}`.execute(db);
  assert.equal(count.rows[0]?.count, 5);

  const legacy = await editSettings(exported.value, rows => rows.filter(row => row.kind !== "clinicIntake"));
  const importedLegacy = await new ReferenceTenantConfigArchiveImporter(() => importedAt).stage(
    legacy, target.tenantId, "buyer-owner", authority, mapper);
  assert.ok(importedLegacy.ok);
  const legacyPolicy = await importedLegacy.value.policy.read(targetSecond);
  assert.ok(legacyPolicy.ok);
  assert.equal(legacyPolicy.value.firstTimeIntakeVersion, "0");
  assert.equal(legacyPolicy.value.firstTimeIntakeEnabled, false);
  assert.deepEqual(await importedLegacy.value.policy.listFirstTimeIntakeChanges(target), ok({ entries: [] }));
});

test("E2E-255 intake archives reject broken or private history, omitted clinics and an occupied intake-only target", async () => {
  const suffix = randomUUID();
  const source = { tenantId: `intake-check-source-${suffix}`, clinicId: "clinic", locationId: "main" };
  const target = { tenantId: `intake-check-target-${suffix}`, clinicId: "buyer", locationId: "main" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy);
  assert.ok((await policy.changeFirstTimeIntakeEnabled(source, "0", true, "source-owner")).ok);
  assert.ok((await policy.changeFirstTimeIntakeEnabled(source, "1", true, "source-owner")).ok);
  const request = { sourceTenantId: source.tenantId, archiveId: `intake-check-archive-${suffix}`, actorRef: "source-owner",
    createdAt: "2026-10-02T16:00:00.000Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
    ] };
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "source-audit" }) };
  const archive = await buildPostgresTenantConfigArchive(db, request, exportAuthority);
  assert.ok(archive.ok);
  const single = await new ReferenceConfigArchiveImporter(() => importedAt).stage(
    archive.value, target, "buyer-owner", authority, mapper);
  assert.ok(single.ok);
  const singlePolicy = await single.value.policy.read(target);
  assert.ok(singlePolicy.ok);
  assert.equal(singlePolicy.value.firstTimeIntakeVersion, "3");
  assert.equal(singlePolicy.value.firstTimeIntakeEnabled, false);
  for (const edit of [
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "clinicIntake" && row.version === 2 ? { ...row, previousEnabled: false } : row),
    (rows: Record<string, unknown>[]) => rows.filter(row => row.kind !== "clinicIntake" || row.version !== 1),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "clinicIntake" && row.version === 1 ? { ...row, isHead: true } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "clinicIntake" && row.version === 1 ? { ...row, patientNotes: "PRIVATE_INTAKE_ARCHIVE_CANARY" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "clinicIntake" && row.version === 1 ? { ...row, changedBy: " " } : row),
  ]) {
    const invalid = await editSettings(archive.value, edit);
    const decoded = await decodeTenantConfigArchive(invalid, target.tenantId);
    assert.deepEqual(decoded, { ok: false, error: { kind: "invalidConfigArchive", section: "settings" } });
    assert.deepEqual(await new PostgresTenantConfigArchiveImporter(db).preflight(
      invalid, target.tenantId, "buyer-owner", authority, mapper), decoded);
  }
  assert.ok((await policy.changeFirstTimeIntakeEnabled(target, "0", false, "target-owner")).ok);
  assert.deepEqual(await new PostgresTenantConfigArchiveImporter(db).preflight(
    archive.value, target.tenantId, "buyer-owner", authority, mapper), { ok: false, error: { kind: "targetOccupied" } });
  assert.ok((await policy.changeFirstTimeIntakeEnabled({ ...source, clinicId: "omitted" }, "0", true, "source-owner")).ok);
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, request, exportAuthority),
    { ok: false, error: { kind: "scopeIncomplete" } });
  await sql`update clinic_intake_settings set previous_enabled = false
    where tenant_id = ${source.tenantId} and clinic_id = ${source.clinicId} and version = 2`.execute(db);
  const fullRequest = { ...request, locations: [...request.locations, {
    sourceScope: { ...source, clinicId: "omitted" }, targetScope: { ...target, clinicId: "mapped-other" },
    timeZone: "UTC", mappingProvenance: "reviewed",
  }] };
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, fullRequest, exportAuthority),
    { ok: false, error: { kind: "storageCorrupt" } });
});
