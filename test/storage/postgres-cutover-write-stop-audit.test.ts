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

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

test("E2E-167 imported write-stop audit drift blocks number publication", async () => {
  const suffix = randomUUID().slice(0, 8);
  const source = { tenantId: `stop-source-${suffix}`, clinicId: "clinic", locationId: "main" };
  const target = { tenantId: `stop-target-${suffix}`, clinicId: "clinic", locationId: "main" };
  const accountRef = `stop-account-${suffix}`;
  const dialedNumber = "+6125550199";
  await sql`insert into number_routes (account_ref, dialed_number, version, assignment)
    values (${accountRef}, ${dialedNumber}, 1,
      ${JSON.stringify({ tenantId: source.tenantId, clinicId: source.clinicId,
        candidateLocationIds: [source.locationId] })}::jsonb)`.execute(db);
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, undefined, undefined, true, "unsafeReference");
  assert.equal((await policy.changeBookingEnabled(source, "0", false, "source-admin")).ok, true);
  const fence = new PostgresPortabilityFence(db);
  const fenceAuthority = { authorizeAndRecord: async () => ok({ requestRef: `stop-fence-${suffix}` }) };
  assert.equal((await fence.freeze({ tenantId: source.tenantId, actorRef: "source-admin",
    reason: "cutoverFreeze" }, fenceAuthority)).ok, true);
  const request = { sourceTenantId: source.tenantId, archiveId: `stop-archive-${suffix}`,
    actorRef: "source-admin", archiveMode: "unsafeReference" as const,
    createdAt: "2026-09-29T00:00:00Z", expectedFenceVersion: 1,
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }] };
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: `stop-export-${suffix}` }) };
  const archive = await buildPostgresFencedTenantConfigArchive(db, request, exportAuthority);
  assert.equal(archive.ok, true);
  if (!archive.ok) return;
  const imported = await new PostgresTenantConfigArchiveImporter(db, undefined, "unsafeReference").stage(
    archive.value, target.tenantId, "target-admin",
    { authorizeAndRecord: async () => ok({ auditRef: `stop-import-${suffix}` }) },
    { mapRef: (kind, ref) => `target:${kind}:${ref}` });
  assert.equal(imported.ok, true);
  assert.equal((await new PostgresPatientPhoneIndex(db).publish(target, [], "61")).ok, true);
  const cutover = new PostgresConfigNumberCutover(db);
  const command = { accountRef, dialedNumber, actorRef: "route-admin" };
  let routeAudits = 0;
  const routeAuthority = { authorizeAndRecord: async () => ok({ auditRef: `stop-route-${suffix}-${++routeAudits}` }) };
  const staged = await cutover.stage({ ...command, expectedRouteVersion: 1,
    targetPhoneIndex: { countryCallingCode: "61", maxAgeMs: 30 * 60_000 }, baseline: archive.value,
    comparison: { ...request, archiveId: `stop-comparison-${suffix}` } }, routeAuthority, exportAuthority);
  assert.equal(staged.ok, true);
  const original = (await sql<{ reason: string }>`select reason from clinic_write_stop_events
    where tenant_id = ${target.tenantId} and clinic_id = ${target.clinicId} and version = 1`.execute(db)).rows[0];
  assert.ok(original?.reason);
  await sql`update clinic_write_stop_events set reason = 'tampered audit event'
    where tenant_id = ${target.tenantId} and clinic_id = ${target.clinicId} and version = 1`.execute(db);
  assert.deepEqual(await cutover.publish(command, routeAuthority),
    { ok: false, error: { kind: "targetNotReady" } });
  let active = await new PostgresNumberRoutingHost(db).identifyCall(accountRef, dialedNumber);
  assert.equal(active.ok && active.value.tenantId, source.tenantId);
  await sql`update clinic_write_stop_events set reason = ${original.reason}
    where tenant_id = ${target.tenantId} and clinic_id = ${target.clinicId} and version = 1`.execute(db);
  await sql`insert into clinic_write_stop_events
    (tenant_id, clinic_id, version, stopped, actor_ref, reason, changed_at)
    values (${target.tenantId}, ${target.clinicId}, 2, true, 'test-operator', 'unlisted audit event',
      clock_timestamp())`.execute(db);
  assert.deepEqual(await cutover.publish(command, routeAuthority),
    { ok: false, error: { kind: "targetNotReady" } });
  active = await new PostgresNumberRoutingHost(db).identifyCall(accountRef, dialedNumber);
  assert.equal(active.ok && active.value.tenantId, source.tenantId);
  await sql`delete from clinic_write_stop_events where tenant_id = ${target.tenantId}
    and clinic_id = ${target.clinicId} and version = 2`.execute(db);
  const published = await cutover.publish(command, routeAuthority);
  assert.equal(published.ok && published.value.activeTenantId, target.tenantId, JSON.stringify(published));
});
