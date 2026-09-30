import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import type { ReferenceTenantImportReport } from "../../src/reference/tenant-config-archive-import.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresFencedTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresConfigNumberCutover, PostgresNumberRoutingHost } from "../../src/storage/postgres-number-cutover.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";

const fingerprint = "a".repeat(64);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("E2E-168 altered import receipt counts, digests, or location omissions cannot publish a route", async () => {
  const suffix = randomUUID().slice(0, 8);
  const source = { tenantId: `receipt-source-${suffix}`, clinicId: "clinic", locationId: "main" };
  const target = { tenantId: `receipt-target-${suffix}`, clinicId: "clinic", locationId: "main" };
  const accountRef = `receipt-account-${suffix}`;
  const dialedNumber = "+6125550199";
  await sql`insert into number_routes (account_ref, dialed_number, version, assignment)
    values (${accountRef}, ${dialedNumber}, 1,
      ${JSON.stringify({ tenantId: source.tenantId, clinicId: source.clinicId,
        candidateLocationIds: [source.locationId] })}::jsonb)`.execute(db);
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(source, "0", false, "source-admin")).ok, true);
  const fence = new PostgresPortabilityFence(db);
  const fenceAuthority = { authorizeAndRecord: async () => ok({ requestRef: `receipt-fence-${suffix}` }) };
  assert.equal((await fence.freeze({ tenantId: source.tenantId, actorRef: "source-admin",
    reason: "cutoverFreeze" }, fenceAuthority)).ok, true);
  const request = { sourceTenantId: source.tenantId, archiveId: `receipt-archive-${suffix}`,
    actorRef: "source-admin", archiveMode: "unsafeReference" as const,
    createdAt: "2026-09-29T00:00:00Z", expectedFenceVersion: 1,
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }] };
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: `receipt-export-${suffix}` }) };
  const archive = await buildPostgresFencedTenantConfigArchive(db, request, exportAuthority);
  assert.equal(archive.ok, true);
  if (!archive.ok) return;
  const imported = await new PostgresTenantConfigArchiveImporter(db, undefined, "unsafeReference").stage(
    archive.value, target.tenantId, "target-admin",
    { authorizeAndRecord: async () => ok({ auditRef: `receipt-import-${suffix}` }) },
    { mapRef: (kind, ref) => `target:${kind}:${ref}` });
  assert.equal(imported.ok, true);
  assert.equal((await new PostgresPatientPhoneIndex(db).publish(target, [], "61", fingerprint)).ok, true);
  const cutover = new PostgresConfigNumberCutover(db);
  const command = { accountRef, dialedNumber, actorRef: "route-admin" };
  let routeAudits = 0;
  const routeAuthority = { authorizeAndRecord: async () => ok({ auditRef: `receipt-route-${suffix}-${++routeAudits}` }) };
  const staged = await cutover.stage({ ...command, expectedRouteVersion: 1,
    targetPhoneIndex: { countryCallingCode: "61", maxAgeMs: 30 * 60_000 }, baseline: archive.value,
    comparison: { ...request, archiveId: `receipt-comparison-${suffix}` } }, routeAuthority, exportAuthority);
  assert.equal(staged.ok, true);
  const original = (await sql<{ receipt: ReferenceTenantImportReport }>`select receipt from tenant_config_imports
    where target_tenant_id = ${target.tenantId}`.execute(db)).rows[0]?.receipt;
  assert.ok(original);
  async function assertMismatch(changed: ReferenceTenantImportReport): Promise<void> {
    await sql`update tenant_config_imports set receipt = ${JSON.stringify(changed)}::jsonb
      where target_tenant_id = ${target.tenantId}`.execute(db);
    assert.deepEqual(await cutover.publish(command, routeAuthority),
      { ok: false, error: { kind: "targetImportMismatch" } });
    const active = await new PostgresNumberRoutingHost(db).identifyCall(accountRef, dialedNumber);
    assert.equal(active.ok && active.value.tenantId, source.tenantId);
  }
  await assertMismatch({ ...original, recordCounts: { ...original.recordCounts, calls: 1 } });
  await assertMismatch({ ...original, sectionDigests: { ...original.sectionDigests,
    settings: "0".repeat(64) } });
  await assertMismatch({ ...original, locations: original.locations.map(location =>
    ({ ...location, omittedTextCalls: (location.omittedTextCalls ?? 0) + 1 })) });
  await sql`update tenant_config_imports set receipt = ${JSON.stringify(original)}::jsonb
    where target_tenant_id = ${target.tenantId}`.execute(db);
  const published = await cutover.publish(command, routeAuthority);
  assert.equal(published.ok && published.value.activeTenantId, target.tenantId, JSON.stringify(published));
});
