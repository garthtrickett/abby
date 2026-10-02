import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { err, ok } from "../../src/core/model.ts";
import type { LocationScope, Result } from "../../src/core/model.ts";
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
import { staffedDestinationRegistry } from "../support/staffed-destination-registry.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
const authority = { authorizeAndRecord: async () => ok({ auditRef: "reviewed-import" }) };
const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "reviewed-export" }) };
const importedAt = "2026-10-02T19:00:00.000Z";
function value<T>(result: Result<T, { kind: string }>): T { assert.ok(result.ok, result.ok ? "" : result.error.kind); return result.value; }
const registry = staffedDestinationRegistry(async (scope, ref) => ["host/desk-a", "host/desk-b"].includes(ref)
  ? ok({ scope, destinationRef: ref, hostVersion: "source-routes-v1", mode: "execute", ready: true })
  : err({ kind: "readinessFailed", missing: ["staffDestination"] }));
function policy(mode: "standaloneMinimal" | "unsafeReference" = "standaloneMinimal") {
  return new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, true, mode, false, undefined, registry);
}
const mapper = { mapRef: (kind: string, ref: string, source: LocationScope, target: LocationScope) =>
  kind === "transferDestination" ? `${target.locationId}/buyer/${ref}` : `buyer:${kind}:${ref}` };

// Reseal edited data so rejection proves semantic validation, rather than only a checksum mismatch.
async function editSettings(input: ArchiveEnvelope, edit: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<ArchiveEnvelope> {
  const result = value(await materializeVerifiedArchive(input));
  const parts = { ...result.sections };
  const rows = Buffer.from(parts.settings).toString().trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const next = edit(rows);
  parts.settings = Buffer.from(next.map(row => JSON.stringify(row)).join("\n") + "\n");
  const manifest = JSON.parse(Buffer.from(result.manifestBytes).toString()) as {
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
async function archive(source: LocationScope, target: LocationScope, mode: "standaloneMinimal" | "unsafeReference" = "standaloneMinimal") {
  return value(await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: source.tenantId, archiveId: `staffed-archive-${randomUUID()}`, actorRef: "source-owner", archiveMode: mode,
    createdAt: importedAt, locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }],
  }, exportAuthority));
}
async function source(mode: "standaloneMinimal" | "unsafeReference") {
  const scope = { tenantId: `staffed-source-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const target = { tenantId: `staffed-target-${randomUUID()}`, clinicId: "buyer", locationId: "main" };
  const store = policy(mode);
  value(await store.changeStaffedDestination(scope, "0", "host/desk-a", "source-owner"));
  value(await store.changeBookingEnabled(scope, "1", true, "source-owner"));
  value(await store.changeStaffedDestination(scope, "2", "host/desk-b", "source-owner"));
  value(await store.changeStaffedDestination(scope, "3", null, "source-owner"));
  value(await store.changeStaffedDestination(scope, "4", "host/desk-a", "source-owner"));
  return { scope, target, store, input: await archive(scope, target, mode) };
}

for (const mode of ["standaloneMinimal", "unsafeReference"] as const) {
  test(`E2E-256 SET-007 ${mode} transfer import maps current and historical refs without granting execution`, async () => {
    const { scope, target, store, input } = await source(mode);
    const decoded = value(await decodeTenantConfigArchive(input, target.tenantId));
    const sourceRows = decoded.locations[0]!.policies;
    assert.deepEqual(sourceRows.filter(row => row.settingKind === "staffedDestination")
      .map(row => [row.version, row.policy.transferDestinationRef ?? null, row.previousStaffedDestinationRef]),
    [[1, "host/desk-a", null], [3, "host/desk-b", "host/desk-a"], [4, null, "host/desk-b"], [5, "host/desk-a", null]]);
    assert.ok(sourceRows.every(row => row.policy.transferDestinationVersion === undefined));
    const tenant = value(await new ReferenceTenantConfigArchiveImporter(() => importedAt).stage(input, target.tenantId,
      "buyer-owner", authority, mapper));
    const single = value(await new ReferenceConfigArchiveImporter(() => importedAt).stage(input, target, "buyer-owner", authority, mapper));
    const importer = new PostgresTenantConfigArchiveImporter(db, () => importedAt, mode);
    const receipt = value(await importer.stage(input, target.tenantId, "buyer-owner", authority, mapper));
    const reconstructed = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, true, mode);
    const expected = [["1", "main/buyer/host/desk-a", null], ["3", "main/buyer/host/desk-b", "main/buyer/host/desk-a"],
      ["4", null, "main/buyer/host/desk-b"], ["5", "main/buyer/host/desk-a", null]];
    for (const targetStore of [tenant.policy, single.policy, reconstructed]) {
      const current = value(await targetStore.read(target));
      assert.equal(current.transferDestinationRef, "main/buyer/host/desk-a");
      assert.equal(current.transferDestinationVersion, undefined);
      assert.notEqual(current.capabilities.transfer, "execute");
      assert.equal(current.bookingEnabled, false);
      assert.equal(current.automationEnabled, false);
      assert.equal(current.policyVersion, "6", "forced booking disable preserves the configured route");
      const history = value(await targetStore.listStaffedDestinationChanges(target)).entries;
      assert.deepEqual(history.map(row => [row.version, row.destinationRef, row.previousDestinationRef]), expected);
      assert.ok(history.every(row => row.actorRef === "source-owner" && Number.isFinite(Date.parse(row.changedAt))));
    }
    const mappings = receipt.mappings.filter(row => row.kind === "transferDestination");
    assert.deepEqual(mappings.map(row => [row.sourceRef, row.targetRef]),
      [["host/desk-a", "main/buyer/host/desk-a"], ["host/desk-b", "main/buyer/host/desk-b"]]);
    assert.ok(mappings.every(row => row.sourceScope.tenantId === scope.tenantId && row.targetScope.tenantId === target.tenantId));
    const retained = value(await importer.read(target.tenantId, "buyer-owner", authority));
    assert.ok(retained);
    assert.deepEqual(retained.sourceHistory, decoded);
    value(await importer.stage(input, target.tenantId, "buyer-owner", authority, mapper));
    assert.equal((await sql<{ count: number }>`select count(*)::int as count from clinic_settings where tenant_id = ${target.tenantId}`.execute(db)).rows[0]?.count, 7);
    assert.equal(value(await store.read(scope)).transferDestinationRef, "host/desk-a");
  });
}

test("E2E-256 SET-007 route archive rejects missing, forged or unrelated history and missing host mappings before writing", async () => {
  const { target, input } = await source("standaloneMinimal");
  const routeAt = (row: Record<string, unknown>, version: number) => row.kind === "locationPolicy" && row.version === version;
  for (const edit of [
    (rows: Record<string, unknown>[]) => rows.map(row => routeAt(row, 3) ? { ...row, previousStaffedDestinationRef: "wrong-route" } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => { if (!routeAt(row, 1)) return row; const { previousStaffedDestinationRef, ...rest } = row; return rest; }),
    (rows: Record<string, unknown>[]) => rows.filter(row => !routeAt(row, 3)),
    (rows: Record<string, unknown>[]) => rows.map(row => routeAt(row, 3) ? { ...row, previousStaffedDestinationRef: { patientNotes: "PRIVATE_ROUTE_CANARY" } } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => routeAt(row, 3) ? { ...row, changedBy: " " } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => routeAt(row, 3) ? { ...row, policy: { ...row.policy as object, bookingEnabled: false } } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => routeAt(row, 2) ? { ...row, policy: { ...row.policy as object, transferDestinationRef: "host/desk-b" } } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => routeAt(row, 3) ? { ...row, policy: { ...row.policy as object, transferDestinationVersion: "forged-permission" } } : row),
    (rows: Record<string, unknown>[]) => rows.map(row => routeAt(row, 2) ? { ...row, previousStaffedDestinationRef: "host/desk-a" } : row),
  ]) {
    const invalid = await editSettings(input, edit);
    const rejected = { ok: false, error: { kind: "invalidConfigArchive", section: "settings" } };
    assert.deepEqual(await decodeTenantConfigArchive(invalid, target.tenantId), rejected);
    assert.deepEqual(await new PostgresTenantConfigArchiveImporter(db).stage(invalid, target.tenantId, "buyer-owner", authority, mapper), rejected);
  }
  const unmapped = { mapRef: () => null };
  const importer = new PostgresTenantConfigArchiveImporter(db);
  assert.deepEqual(await importer.preflight(input, target.tenantId, "buyer-owner", authority, unmapped), { ok: false, error: { kind: "unmappedRef" } });
  assert.deepEqual(await importer.stage(input, target.tenantId, "buyer-owner", authority, unmapped), { ok: false, error: { kind: "unmappedRef" } });
  assert.equal((await sql<{ count: number }>`select count(*)::int as count from clinic_settings where tenant_id = ${target.tenantId}`.execute(db)).rows[0]?.count, 0);
});

test("E2E-256 SET-007 legacy absence and cleared routes remain absent after import", async () => {
  const scope = { tenantId: `route-legacy-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const target = { ...scope, tenantId: `route-legacy-target-${randomUUID()}` };
  const store = policy();
  value(await store.changeBookingEnabled(scope, "0", false, "source-owner"));
  const input = await archive(scope, target);
  const legacy = await editSettings(input, rows => rows.map(row => {
    const { previousStaffedDestinationRef, ...rest } = row;
    return rest;
  }));
  const staged = value(await new ReferenceTenantConfigArchiveImporter().stage(legacy, target.tenantId, "buyer-owner", authority, mapper));
  assert.equal(value(await staged.policy.read(target)).transferDestinationRef, undefined);
  assert.deepEqual(value(await staged.policy.listStaffedDestinationChanges(target)), { entries: [] });
  value(await store.changeStaffedDestination(scope, "1", "host/desk-a", "source-owner"));
  value(await store.changeStaffedDestination(scope, "2", null, "source-owner"));
  const cleared = value(await new PostgresTenantConfigArchiveImporter(db).stage(await archive(scope, target), target.tenantId, "buyer-owner", authority, mapper));
  assert.equal(cleared.status, "staged");
  assert.equal(value(await policy().read(target)).transferDestinationRef, undefined);
  assert.deepEqual(value(await policy().listStaffedDestinationChanges(target)).entries.map(row => [row.destinationRef, row.previousDestinationRef]),
    [["main/buyer/host/desk-a", null], [null, "main/buyer/host/desk-a"]]);
});

test("E2E-256 SET-007 matching source route refs map independently for two locations", async () => {
  const first = { tenantId: `staffed-two-${randomUUID()}`, clinicId: "clinic", locationId: "first" };
  const second = { ...first, locationId: "second" };
  const target = { tenantId: `staffed-two-target-${randomUUID()}`, clinicId: "buyer", locationId: "first" };
  const targetSecond = { ...target, locationId: "second" };
  const store = policy();
  for (const scope of [first, second]) value(await store.changeStaffedDestination(scope, "0", "host/desk-a", "source-owner"));
  const input = value(await buildPostgresTenantConfigArchive(db, {
    sourceTenantId: first.tenantId, archiveId: `staffed-two-archive-${randomUUID()}`, actorRef: "source-owner", createdAt: importedAt,
    locations: [{ sourceScope: first, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" },
      { sourceScope: second, targetScope: targetSecond, timeZone: "UTC", mappingProvenance: "reviewed" }],
  }, exportAuthority));
  const reference = value(await new ReferenceTenantConfigArchiveImporter().stage(input, target.tenantId, "buyer-owner", authority, mapper));
  const imported = value(await new PostgresTenantConfigArchiveImporter(db).stage(input, target.tenantId, "buyer-owner", authority, mapper));
  for (const targetScope of [target, targetSecond]) {
    for (const targetStore of [reference.policy, policy()]) {
      assert.equal(value(await targetStore.read(targetScope)).transferDestinationRef, `${targetScope.locationId}/buyer/host/desk-a`);
      assert.deepEqual(value(await targetStore.listStaffedDestinationChanges(targetScope)).entries.map(row => row.destinationRef),
        [`${targetScope.locationId}/buyer/host/desk-a`]);
    }
  }
  assert.deepEqual(imported.mappings.filter(row => row.kind === "transferDestination")
    .map(row => [row.sourceScope.locationId, row.targetScope.locationId, row.targetRef]),
  [["first", "first", "first/buyer/host/desk-a"], ["second", "second", "second/buyer/host/desk-a"]]);
});
