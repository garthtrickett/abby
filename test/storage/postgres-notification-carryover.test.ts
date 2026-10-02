import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { materializeVerifiedArchive } from "../../src/portability/archive-envelope.ts";
import type { ArchiveEnvelope, ArchiveSection } from "../../src/portability/archive-envelope.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { ReferenceConfigArchiveImporter } from "../../src/reference/config-archive-import.ts";
import { ReferenceTenantConfigArchiveImporter } from "../../src/reference/tenant-config-archive-import.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresClinicNotificationSettingStore } from "../../src/storage/postgres-clinic-notification-settings.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { notificationRegistry } from "../support/notification-settings-contract.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
function value<T>(result: Result<T, { kind: string }>): T { assert.ok(result.ok, result.ok ? "" : result.error.kind); return result.value; }
const authority = { authorizeAndRecord: async () => ok({ auditRef: "reviewed-import" }) };
const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "reviewed-export" }) };
const mapper = { mapRef: (kind: string, ref: string) => `buyer:${kind}:${ref}` };
const at = "2026-10-02T21:00:00.000Z";

async function editSettings(input: ArchiveEnvelope, edit: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<ArchiveEnvelope> {
  const result = value(await materializeVerifiedArchive(input));
  const parts = { ...result.sections };
  const rows = Buffer.from(parts.settings).toString().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const next = edit(rows); parts.settings = Buffer.from(next.map(row => JSON.stringify(row)).join("\n") + "\n");
  const manifest = JSON.parse(Buffer.from(result.manifestBytes).toString()) as { sections: Record<string, { recordCount: number; byteCount: number; sha256: string }> };
  manifest.sections.settings = { ...manifest.sections.settings, recordCount: next.length, byteCount: parts.settings.byteLength,
    sha256: createHash("sha256").update(parts.settings).digest("hex") };
  const section = (name: ArchiveSection) => async function* () { yield parts[name]; };
  return { manifestBytes: Buffer.from(JSON.stringify(manifest)), sections: { locations: section("locations"), settings: section("settings"),
    knowledge: section("knowledge"), calls: section("calls"), staffWork: section("staffWork") } };
}
async function fixture(twoLocations = true, mode: "standaloneMinimal" | "unsafeReference" = "standaloneMinimal") {
  const scope = { tenantId: `notification-source-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  const second = { ...scope, locationId: "second" };
  const target = { tenantId: `notification-target-${randomUUID()}`, clinicId: "buyer", locationId: "first" };
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, mode);
  value(await policy.changeBookingEnabled(scope, "0", false, "source-owner"));
  if (twoLocations) value(await policy.changeBookingEnabled(second, "0", false, "source-owner"));
  const raw = new PostgresClinicNotificationSettingStore(db, notificationRegistry());
  value(await raw.changeOwner(scope, "0", "bookingConfirmation", "host", "owner-first"));
  value(await raw.changeOwner(second, "1", "cancellationConfirmation", "host", "owner-second"));
  value(await raw.changeOwner(second, "2", "reschedulingConfirmation", "abby", "owner-second"));
  value(await raw.changeOwner(scope, "3", "bookingConfirmation", "abby", "owner-first"));
  const request = { sourceTenantId: scope.tenantId, archiveId: `notifications-archive-${randomUUID()}`, actorRef: "source-owner", createdAt: at,
    archiveMode: mode, locations: [{ sourceScope: scope, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
      ...(twoLocations ? [{ sourceScope: second, targetScope: { ...target, locationId: "second" }, timeZone: "UTC", mappingProvenance: "reviewed" }] : [])] };
  return { scope, second, target, raw, request, input: value(await buildPostgresTenantConfigArchive(db, request, exportAuthority)) };
}

for (const mode of ["standaloneMinimal", "unsafeReference"] as const) {
  test(`E2E-257 SET-009 ${mode} exports one clinic history and audits each target clear across both locations`, async () => {
    const app = await fixture(true, mode);
    const decoded = value(await decodeTenantConfigArchive(app.input, app.target.tenantId));
    assert.equal(decoded.clinics.length, 1); assert.equal(decoded.clinics[0]!.clinicNotifications?.length, 5);
    const verified = value(await materializeVerifiedArchive(app.input));
    const publicRows = Buffer.from(verified.sections.settings).toString().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(row => row.kind === "clinicNotifications");
    for (const row of publicRows) assert.deepEqual(Object.keys(row).sort(), ["recordVersion", "recordId", "sourceTenantId", "sourceClinicId", "kind", "version",
      "isHead", "owners", "notificationKind", "owner", "previousOwner", "changedBy", "changedAt"].sort());
    const reference = value(await new ReferenceTenantConfigArchiveImporter(() => at).stage(app.input, app.target.tenantId, "buyer-owner", authority, mapper));
    const importer = new PostgresTenantConfigArchiveImporter(db, () => at, mode);
    value(await importer.stage(app.input, app.target.tenantId, "buyer-owner", authority, mapper));
    const durable = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, mode);
    for (const scope of [app.target, { ...app.target, locationId: "second" }]) {
      for (const store of [reference.policy, durable]) {
        const current = value(await store.read(scope));
        assert.deepEqual(current.notificationSettings, { version: "7", owners: {
          bookingConfirmation: null, cancellationConfirmation: null, reschedulingConfirmation: null } });
        assert.deepEqual(current.notificationBindings, {}); assert.equal(current.automationEnabled, false); assert.equal(current.bookingEnabled, false);
      }
    }
    const original = value(await app.raw.listChanges(app.scope));
    const expected = value(await reference.policy.listNotificationChanges(app.target));
    assert.deepEqual(expected.entries.slice(0, 4), original.entries);
    assert.deepEqual(expected.entries.slice(4).map(row => [row.version, row.kind, row.owner, row.previousOwner, row.changedAt]),
      [["5", "bookingConfirmation", null, "abby", at], ["6", "cancellationConfirmation", null, "host", at], ["7", "reschedulingConfirmation", null, "abby", at]]);
    assert.deepEqual(value(await durable.listNotificationChanges({ ...app.target, locationId: "second" })), expected);
    const retained = value(await importer.read(app.target.tenantId, "buyer-owner", authority)); assert.ok(retained);
    assert.deepEqual(retained.sourceHistory.clinics[0]!.clinicNotifications, decoded.clinics[0]!.clinicNotifications);
    value(await importer.stage(app.input, app.target.tenantId, "buyer-owner", authority, mapper));
    assert.equal((await sql<{ count: number }>`select count(*)::int as count from clinic_notification_settings where tenant_id = ${app.target.tenantId}`.execute(db)).rows[0]!.count, 8);
  });
}

test("E2E-257 SET-009 single-location reference import and legacy absence retain safe preferences and empty authority", async () => {
  const app = await fixture(false);
  const staged = value(await new ReferenceConfigArchiveImporter(() => at).stage(app.input, app.target, "buyer-owner", authority, mapper));
  assert.equal(value(await staged.policy.read(app.target)).notificationSettings?.version, "7");
  assert.deepEqual(value(await staged.policy.read(app.target)).notificationBindings, {});
  const legacy = await editSettings(app.input, rows => rows.filter(row => row.kind !== "clinicNotifications"));
  const target = app.target;
  const reference = value(await new ReferenceTenantConfigArchiveImporter(() => at).stage(legacy, target.tenantId, "buyer-owner", authority, mapper));
  value(await new PostgresTenantConfigArchiveImporter(db).stage(legacy, target.tenantId, "buyer-owner", authority, mapper));
  for (const store of [reference.policy, new PostgresPolicyStore(db, referenceDefaultPolicy)]) {
    assert.deepEqual(value(await store.read(target)).notificationSettings, { version: "0", owners: {
      bookingConfirmation: null, cancellationConfirmation: null, reschedulingConfirmation: null } });
    assert.deepEqual(value(await store.listNotificationChanges(target)), { entries: [] });
  }
});

test("E2E-257 SET-009 resealed incomplete, forged or private notification histories reject before any target write", async () => {
  const app = await fixture(false);
  const atVersion = (row: Record<string, unknown>, version: number) => row.kind === "clinicNotifications" && row.version === version;
  const edits = [
    (rows: Record<string, unknown>[]) => rows.filter(row => !atVersion(row, 2)),
    (rows: Record<string, unknown>[]) => [...rows, rows.find(row => atVersion(row, 2))!],
    (rows: Record<string, unknown>[]) => rows.map(row => atVersion(row, 2) ? { ...row, previousOwner: "abby" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => atVersion(row, 4) ? { ...row, owner: "host" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => atVersion(row, 2) ? { ...row, owners: { ...row.owners as object, bookingConfirmation: "abby" } } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => atVersion(row, 0) ? { ...row, isHead: true } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => atVersion(row, 4) ? { ...row, owners: { ...row.owners as object, patientNotes: "PRIVATE_NOTIFICATION_CANARY" } } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => atVersion(row, 4) ? { ...row, hostVersion: "forged-authority" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => atVersion(row, 1) ? { ...row, changedBy: " " } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => atVersion(row, 1) ? { ...row, changedAt: "invalid" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => row.kind === "locationPolicy" ? { ...row, policy: { ...row.policy as object, notificationBindings: { bookingConfirmation: "forged" } } } : row),
  ];
  for (const [index, edit] of edits.entries()) {
    const invalid = await editSettings(app.input, edit);
    const expected = { ok: false, error: { kind: index === 1 ? "duplicateOrUnsorted" : "invalidConfigArchive", section: "settings" } };
    assert.deepEqual(await decodeTenantConfigArchive(invalid, app.target.tenantId), expected);
    assert.deepEqual(await new PostgresTenantConfigArchiveImporter(db).stage(invalid, app.target.tenantId, "buyer-owner", authority, mapper), expected);
  }
  assert.equal((await sql<{ count: number }>`select count(*)::int as count from clinic_notification_settings where tenant_id = ${app.target.tenantId}`.execute(db)).rows[0]!.count, 0);
});

test("E2E-257 SET-009 source freeze blocks notification changes and raw writes; orphan clinics cannot disappear from export", async () => {
  const app = await fixture(false);
  value(await new PostgresPortabilityFence(db).freeze({ tenantId: app.scope.tenantId, actorRef: "owner", reason: "cutoverFreeze" }, exportAuthority));
  assert.deepEqual(await app.raw.changeOwner(app.scope, "4", "bookingConfirmation", null, "owner"), { ok: false, error: { kind: "storageFailure" } });
  await assert.rejects(sql`delete from clinic_notification_settings where tenant_id = ${app.scope.tenantId}`.execute(db), /fence active/);
  await assert.rejects(sql`update clinic_notification_settings set changed_by = 'forged-owner' where tenant_id = ${app.scope.tenantId} and version = 1`.execute(db), /fence active/);
  await assert.rejects(sql`truncate clinic_notification_settings`.execute(db), /truncate bypasses/);
  assert.equal(value(await app.raw.read(app.scope)).version, "4");
  const other = await fixture(false);
  value(await other.raw.changeOwner({ ...other.scope, clinicId: "unlisted" }, "0", "bookingConfirmation", "host", "owner"));
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, { ...other.request, archiveId: `incomplete-${randomUUID()}` }, exportAuthority),
    { ok: false, error: { kind: "scopeIncomplete" } });
});

test("E2E-257 accepted UTC timestamp spellings retain the same audit instant in reference and PostgreSQL imports", async () => {
  const app = await fixture(false);
  const variant = await editSettings(app.input, rows => rows.map(row => row.kind === "clinicNotifications" && row.version === 1
    ? { ...row, changedAt: "2026-10-02T21:00:00Z" } : row));
  const reference = value(await new ReferenceTenantConfigArchiveImporter(() => at).stage(variant, app.target.tenantId, "buyer-owner", authority, mapper));
  value(await new PostgresTenantConfigArchiveImporter(db, () => at).stage(variant, app.target.tenantId, "buyer-owner", authority, mapper));
  const durable = new PostgresPolicyStore(db, referenceDefaultPolicy);
  const expected = value(await reference.policy.listNotificationChanges(app.target));
  assert.equal(expected.entries[0]!.changedAt, at);
  assert.deepEqual(value(await durable.listNotificationChanges(app.target)), expected);
});
