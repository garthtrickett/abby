import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
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

test("E2E-166 target phone index must be fresh under the staged country and normalization plan before publication", async () => {
  const suffix = randomUUID().slice(0, 8);
  const source = { tenantId: `index-source-${suffix}`, clinicId: "clinic", locationId: "main" };
  const target = { tenantId: `index-target-${suffix}`, clinicId: "clinic", locationId: "main" };
  const accountRef = `index-account-${suffix}`;
  const dialedNumber = "+6125550198";
  const targetPhoneIndex = { countryCallingCode: "61", maxAgeMs: 30 * 60_000 };
  await sql`insert into number_routes (account_ref, dialed_number, version, assignment)
    values (${accountRef}, ${dialedNumber}, 1,
      ${JSON.stringify({ tenantId: source.tenantId, clinicId: source.clinicId,
        candidateLocationIds: [source.locationId] })}::jsonb)`.execute(db);
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(source, "0", false, "source-admin")).ok, true);
  const fence = new PostgresPortabilityFence(db);
  const fenceAuthority = { authorizeAndRecord: async () => ok({ requestRef: `index-fence-${suffix}` }) };
  assert.equal((await fence.freeze({ tenantId: source.tenantId, actorRef: "source-admin",
    reason: "cutoverFreeze" }, fenceAuthority)).ok, true);
  const request = { sourceTenantId: source.tenantId, archiveId: `index-archive-${suffix}`,
    actorRef: "source-admin", archiveMode: "unsafeReference" as const,
    createdAt: "2026-09-29T00:00:00Z", expectedFenceVersion: 1,
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }] };
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: `index-export-${suffix}` }) };
  const archive = await buildPostgresFencedTenantConfigArchive(db, request, exportAuthority);
  assert.equal(archive.ok, true);
  if (!archive.ok) return;
  const imported = await new PostgresTenantConfigArchiveImporter(db, undefined, "unsafeReference").stage(
    archive.value, target.tenantId, "target-admin",
    { authorizeAndRecord: async () => ok({ auditRef: `index-import-${suffix}` }) },
    { mapRef: (kind, ref) => `target:${kind}:${ref}` });
  assert.equal(imported.ok, true);
  const cutover = new PostgresConfigNumberCutover(db);
  const command = { accountRef, dialedNumber, actorRef: "route-admin" };
  let routeAudits = 0;
  const routeAuthority = { authorizeAndRecord: async () => ok({ auditRef: `index-route-${suffix}-${++routeAudits}` }) };
  const stage = { ...command, expectedRouteVersion: 1, targetPhoneIndex, baseline: archive.value,
    comparison: { ...request, archiveId: `index-comparison-${suffix}` } };
  assert.equal((await cutover.stage(stage, routeAuthority, exportAuthority)).ok, true);
  assert.deepEqual(await cutover.stage({ ...stage, targetPhoneIndex: { ...targetPhoneIndex, maxAgeMs: 60_000 } },
    routeAuthority, exportAuthority), { ok: false, error: { kind: "routeConflict" } });
  assert.deepEqual(await cutover.publish(command, routeAuthority),
    { ok: false, error: { kind: "targetPhoneIndexNotReady" } });
  const index = new PostgresPatientPhoneIndex(db);
  assert.equal((await index.publish(target, [], "64", fingerprint)).ok, true);
  assert.deepEqual(await cutover.publish(command, routeAuthority),
    { ok: false, error: { kind: "targetPhoneIndexNotReady" } });
  const current = await index.publish(target, [], "61", fingerprint);
  assert.equal(current.ok, true);
  if (!current.ok) return;
  assert.equal((await index.markStale(target, current.value)).ok, true);
  assert.deepEqual(await cutover.publish(command, routeAuthority),
    { ok: false, error: { kind: "targetPhoneIndexNotReady" } });
  assert.equal((await index.publish(target, [], "61", fingerprint)).ok, true);
  const published = await new PostgresConfigNumberCutover(db).publish(command, routeAuthority);
  assert.equal(published.ok && published.value.activeTenantId, target.tenantId, JSON.stringify(published));
  const route = await new PostgresNumberRoutingHost(db).identifyCall(accountRef, dialedNumber);
  assert.equal(route.ok && route.value.tenantId, target.tenantId);
});
