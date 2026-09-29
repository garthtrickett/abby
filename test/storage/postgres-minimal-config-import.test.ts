import assert from "node:assert/strict";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("default tenant importer writes only minimal policy rows and a strict write stop", async () => {
  const source = { tenantId: "minimal-import-source", clinicId: "clinic", locationId: "location" };
  const target = { tenantId: "minimal-import-target", clinicId: "buyer", locationId: "location" };
  const store = new PostgresPolicyStore(db, referenceDefaultPolicy);
  assert.equal((await store.changeBookingEnabled(source, "0", true, "clinic-admin")).ok, true);
  const archive = await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: source.tenantId, archiveId: "minimal-import-archive", actorRef: "clinic-admin",
    createdAt: "2026-09-29T05:00:00Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "minimal-import-export-audit" }) });
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  const importer = new PostgresTenantConfigArchiveImporter(db, () => "2026-09-29T05:05:00Z");
  const authority = { authorizeAndRecord: async () => ok({ auditRef: "minimal-import-audit" }) };
  const canary = "PATIENT_SECRET_MINIMAL_IMPORT_0930";
  const mapper = { mapRef: () => canary };
  const ready = await importer.preflight(archive.value, target.tenantId, "buyer-admin", authority, mapper);
  assert.ok(ready.ok && ready.value.status === "ready", ready.ok ? "" : ready.error.kind);
  const imported = await importer.stage(archive.value, target.tenantId, "buyer-admin", authority, mapper);
  assert.ok(imported.ok && imported.value.status === "staged", imported.ok ? "" : imported.error.kind);
  assert.equal(imported.value.mappings.every(row => row.targetRef === "disabled"), true);
  const rows = await sql<{ version: number; policy: Record<string, unknown> }>`select version, policy
    from clinic_settings where tenant_id = ${target.tenantId} order by version`.execute(db);
  assert.deepEqual(rows.rows.map(row => [row.version, row.policy]), [
    [0, { scope: target, policyVersion: "0", bookingEnabled: false }],
    [1, { scope: target, policyVersion: "1", bookingEnabled: true }],
    [2, { scope: target, policyVersion: "2", bookingEnabled: false }],
  ]);
  const policy = await store.read(target);
  assert.ok(policy.ok);
  assert.equal(policy.value.bookingEnabled, false);
  const stop = await new PostgresLedger(db).readWriteStop(target);
  assert.ok(stop.ok && stop.value.stopped);
  const reasons = await sql<{ reason: string }>`select reason from clinic_write_stop_events
    where tenant_id = ${target.tenantId}`.execute(db);
  assert.deepEqual(reasons.rows.map(row => row.reason), ["cutover"]);
  const retained = await new PostgresTenantConfigArchiveImporter(db).read(target.tenantId, "buyer-admin", authority);
  assert.ok(retained.ok && retained.value);
  assert.deepEqual(retained.value.sourceHistory.locations[0]?.policies.map(row => row.storageShape),
    ["standaloneMinimal", "standaloneMinimal"]);
  const canaries = await scanPatientDataCanaries(db, [{ label: "mapper", value: canary }]);
  assert.deepEqual(canaries, ok([]));
});

test("default tenant importer rejects rich reference archives before persistence", async () => {
  const source = { tenantId: "minimal-import-rich-source", clinicId: "clinic", locationId: "location" };
  const target = { tenantId: "minimal-import-rich-target", clinicId: "buyer", locationId: "location" };
  const richStore = new PostgresPolicyStore(db, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference");
  assert.equal((await richStore.changeBookingEnabled(source, "0", false, "clinic-admin")).ok, true);
  const archive = await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: source.tenantId, archiveId: "minimal-import-rich-archive", actorRef: "clinic-admin",
    archiveMode: "unsafeReference", createdAt: "2026-09-29T05:00:00Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "minimal-import-rich-export-audit" }) });
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  const importer = new PostgresTenantConfigArchiveImporter(db);
  const authority = { authorizeAndRecord: async () => ok({ auditRef: "minimal-import-rich-audit" }) };
  const mapper = { mapRef: () => "disabled" };
  assert.deepEqual(await importer.preflight(archive.value, target.tenantId, "buyer-admin", authority, mapper),
    { ok: false, error: { kind: "invalidConfigArchive", section: "settings" } });
  assert.deepEqual(await importer.stage(archive.value, target.tenantId, "buyer-admin", authority, mapper),
    { ok: false, error: { kind: "invalidConfigArchive", section: "settings" } });
  const count = await sql<{ count: number }>`select count(*)::int as count from tenant_config_imports
    where target_tenant_id = ${target.tenantId}`.execute(db);
  assert.equal(count.rows[0]?.count, 0);
});
