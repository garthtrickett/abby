import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { standaloneDefaultPolicy } from "../../src/standalone/default-policy.ts";
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
    [0, { scope: target, policyVersion: "0", bookingEnabled: false, cancellationEnabled: false, afterHoursMode: "staffRequest", greeting: null }],
    [1, { scope: target, policyVersion: "1", bookingEnabled: true, cancellationEnabled: false, afterHoursMode: "staffRequest", greeting: null }],
    [2, { scope: target, policyVersion: "2", bookingEnabled: false, cancellationEnabled: false, afterHoursMode: "staffRequest", greeting: null }],
  ]);
  const policy = await store.read(target);
  assert.ok(policy.ok);
  assert.equal(policy.value.bookingEnabled, false);
  assert.equal(policy.value.greeting, undefined);
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

test("E2E-229 durable minimal import preserves after-hours text and audit without enabling booking", async () => {
  const source = { tenantId: "minimal-after-hours-source", clinicId: "clinic", locationId: "location" };
  const target = { tenantId: "minimal-after-hours-target", clinicId: "buyer", locationId: "location" };
  const store = new PostgresPolicyStore(db, referenceDefaultPolicy);
  const info = { scope: source, version: "holiday-v1", ownerRef: "clinic-admin",
    approvedText: "The clinic reopens Tuesday at 9 am.", approved: true as const };
  assert.ok((await store.changeAfterHours(source, "0", "approvedInfoAndRequest", info, "clinic-admin")).ok);
  assert.ok((await store.changeBookingEnabled(source, "1", true, "clinic-admin")).ok);
  const archive = await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: source.tenantId, archiveId: "minimal-after-hours-archive", actorRef: "clinic-admin",
    createdAt: "2026-09-29T05:00:00Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "minimal-after-hours-export-audit" }) });
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  const importer = new PostgresTenantConfigArchiveImporter(db, () => "2026-09-29T05:05:00Z");
  const authority = { authorizeAndRecord: async () => ok({ auditRef: "minimal-after-hours-import-audit" }) };
  const staged = await importer.stage(archive.value, target.tenantId, "buyer-admin", authority,
    { mapRef: () => "disabled" });
  assert.ok(staged.ok, staged.ok ? "" : staged.error.kind);
  const imported = await store.read(target);
  assert.ok(imported.ok);
  assert.equal(imported.value.bookingEnabled, false);
  assert.equal(imported.value.afterHoursMode, "approvedInfoAndRequest");
  assert.equal(imported.value.afterHoursInfo?.approvedText, info.approvedText);
  const afterHours = await store.listAfterHoursChanges(target);
  assert.ok(afterHours.ok);
  assert.deepEqual(afterHours.value.entries.map(row => row.version), ["1"]);
  const booking = await store.listBookingChanges(target);
  assert.ok(booking.ok);
  assert.deepEqual(booking.value.entries.map(row => row.version), ["2", "3"]);
});

test("E2E-232 durable minimal import preserves public urgent wording and audit without enabling calls", async () => {
  const suffix = randomUUID();
  const source = { tenantId: `minimal-urgent-source-${suffix}`, clinicId: "clinic", locationId: "location" };
  const target = { tenantId: `minimal-urgent-target-${suffix}`, clinicId: "buyer", locationId: "location" };
  const store = new PostgresPolicyStore(db, referenceDefaultPolicy);
  const script = { scope: source, version: "urgent-v1", ownerRef: "clinic-admin",
    approvedText: "If you need immediate help, contact your local emergency service now.", approved: true as const,
    effectiveFrom: "2026-09-28T00:00:00.000Z", effectiveUntil: "2027-09-28T00:00:00.000Z" };
  assert.ok((await store.changeUrgentResponse(source, "0", script, "clinic-admin")).ok);
  const archive = await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: source.tenantId, archiveId: `minimal-urgent-archive-${suffix}`, actorRef: "clinic-admin",
    createdAt: "2026-09-29T05:00:00Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "minimal-urgent-export-audit" }) });
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  const importer = new PostgresTenantConfigArchiveImporter(db, () => "2026-09-29T05:05:00Z");
  const authority = { authorizeAndRecord: async () => ok({ auditRef: "minimal-urgent-import-audit" }) };
  const staged = await importer.stage(archive.value, target.tenantId, "buyer-admin", authority,
    { mapRef: () => "disabled" });
  assert.ok(staged.ok, staged.ok ? "" : staged.error.kind);
  const imported = await store.read(target);
  assert.ok(imported.ok);
  assert.equal(imported.value.automationEnabled, false);
  assert.deepEqual(imported.value.urgentResponse?.scope, target);
  assert.equal(imported.value.urgentResponse?.approvedText, script.approvedText);
  const history = await store.listUrgentResponseChanges(target);
  assert.ok(history.ok);
  assert.deepEqual(history.value.entries.map(row => [row.version, row.enabled]), [["1", true]]);
  const stop = await new PostgresLedger(db).readWriteStop(target);
  assert.ok(stop.ok && stop.value.stopped);
});

test("E2E-244 durable minimal import preserves hours and audit without enabling transfer", async () => {
  const suffix = randomUUID();
  const source = { tenantId: `minimal-hours-source-${suffix}`, clinicId: "clinic", locationId: "location" };
  const target = { tenantId: `minimal-hours-target-${suffix}`, clinicId: "buyer", locationId: "location" };
  const store = new PostgresPolicyStore(db, referenceDefaultPolicy);
  const schedule = { scope: source, version: "hours-v1", ownerRef: "clinic-admin", approved: true as const,
    effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2027-09-01T00:00:00.000Z",
    timeZone: "Australia/Sydney", weekly: [{ weekday: 1, startMinute: 1140, endMinute: 1260 }],
    closedDates: ["2026-12-25"] };
  assert.ok((await store.changeStaffSchedule(source, "0", schedule, "clinic-admin")).ok);
  const archive = await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: source.tenantId, archiveId: `minimal-hours-archive-${suffix}`, actorRef: "clinic-admin",
    createdAt: "2026-09-29T05:00:00Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "Australia/Sydney", mappingProvenance: "reviewed" },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "minimal-hours-export-audit" }) });
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  const importer = new PostgresTenantConfigArchiveImporter(db, () => "2026-09-29T05:05:00Z");
  const authority = { authorizeAndRecord: async () => ok({ auditRef: "minimal-hours-import-audit" }) };
  const staged = await importer.stage(archive.value, target.tenantId, "buyer-admin", authority,
    { mapRef: () => "ignored-by-minimal-import" });
  assert.ok(staged.ok, staged.ok ? "" : staged.error.kind);
  const imported = await store.read(target);
  assert.ok(imported.ok);
  assert.equal(imported.value.capabilities.transfer, "unavailable");
  assert.deepEqual(imported.value.staffSchedule?.scope, target);
  assert.equal(imported.value.staffSchedule?.ownerRef, "disabled");
  assert.deepEqual(imported.value.staffSchedule?.closedDates, ["2026-12-25"]);
  const history = await store.listStaffScheduleChanges(target);
  assert.ok(history.ok);
  assert.deepEqual(history.value.entries.map(row => [row.version, row.enabled, row.previousEnabled]),
    [["1", true, false]]);
  const stop = await new PostgresLedger(db).readWriteStop(target);
  assert.ok(stop.ok && stop.value.stopped);
});

test("E2E-245 durable minimal import preserves the greeting and its audit", async () => {
  const suffix = randomUUID();
  const source = { tenantId: `minimal-greeting-source-${suffix}`, clinicId: "clinic", locationId: "location" };
  const target = { tenantId: `minimal-greeting-target-${suffix}`, clinicId: "buyer", locationId: "location" };
  const store = new PostgresPolicyStore(db, standaloneDefaultPolicy);
  const greeting = { scope: source, version: "welcome-v1", ownerRef: "clinic-admin", approved: true as const,
    approvedText: "Welcome to the clinic. How can I help?",
    effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2027-09-01T00:00:00.000Z" };
  assert.ok((await store.changeGreeting(source, "0", greeting, "clinic-admin")).ok);
  const archive = await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: source.tenantId, archiveId: `minimal-greeting-archive-${suffix}`, actorRef: "clinic-admin",
    createdAt: "2026-09-29T05:00:00Z", locations: [
      { sourceScope: source, targetScope: target, timeZone: "Australia/Sydney", mappingProvenance: "reviewed" },
    ],
  }, { authorizeAndRecord: async () => ok({ requestRef: "minimal-greeting-export-audit" }) });
  assert.ok(archive.ok, archive.ok ? "" : archive.error.kind);
  const importer = new PostgresTenantConfigArchiveImporter(db, () => "2026-09-29T05:05:00Z");
  const staged = await importer.stage(archive.value, target.tenantId, "buyer-admin",
    { authorizeAndRecord: async () => ok({ auditRef: "minimal-greeting-import-audit" }) },
    { mapRef: () => "ignored-by-minimal-import" });
  assert.ok(staged.ok, staged.ok ? "" : staged.error.kind);
  const imported = await store.read(target);
  assert.ok(imported.ok);
  assert.equal(imported.value.automationEnabled, false);
  assert.deepEqual(imported.value.greeting?.scope, target);
  assert.equal(imported.value.greeting?.ownerRef, "disabled");
  assert.equal(imported.value.greeting?.approvedText, greeting.approvedText);
  const history = await store.listGreetingChanges(target);
  assert.ok(history.ok);
  assert.deepEqual(history.value.entries.map(row => [row.version, row.enabled, row.previousEnabled]),
    [["1", true, false]]);
  const stop = await new PostgresLedger(db).readWriteStop(target);
  assert.ok(stop.ok && stop.value.stopped);
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
