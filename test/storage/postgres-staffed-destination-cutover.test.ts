import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { buildPostgresFencedTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresConfigNumberCutover, PostgresNumberRoutingHost } from "../../src/storage/postgres-number-cutover.ts";
import { PostgresPatientPhoneIndex } from "../../src/storage/postgres-patient-phone-index.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { staffedDestinationRegistry } from "../support/staffed-destination-registry.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
function value<T>(result: Result<T, { kind: string }>): T { assert.ok(result.ok, result.ok ? "" : result.error.kind); return result.value; }

test("E2E-256 SET-007 transfer history and mapped metadata reconcile before publishing a number route", async () => {
  const suffix = randomUUID();
  const source = { tenantId: `staffed-cutover-source-${suffix}`, clinicId: "clinic", locationId: "main" };
  const target = { ...source, tenantId: `staffed-cutover-target-${suffix}` };
  const accountRef = `staffed-account-${suffix}`;
  const dialedNumber = "+6125550199";
  await sql`insert into number_routes (account_ref, dialed_number, version, assignment)
    values (${accountRef}, ${dialedNumber}, 1, ${JSON.stringify({ tenantId: source.tenantId,
      clinicId: source.clinicId, candidateLocationIds: [source.locationId] })}::jsonb)`.execute(db);
  const registry = staffedDestinationRegistry(async (scope, ref) => ok({ scope, destinationRef: ref,
    hostVersion: "source-route-v1", mode: "execute", ready: true }));
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, true, "unsafeReference", false, undefined, registry);
  value(await policy.changeStaffedDestination(source, "0", "host/desk-a", "source-admin"));
  value(await policy.changeStaffedDestination(source, "1", "host/desk-b", "source-admin"));
  value(await new PostgresPortabilityFence(db).freeze({ tenantId: source.tenantId,
    actorRef: "source-admin", reason: "cutoverFreeze" }, { authorizeAndRecord: async () => ok({ requestRef: "reviewed-freeze" }) }));
  const request = { sourceTenantId: source.tenantId, archiveId: `staffed-fenced-${suffix}`, actorRef: "source-admin",
    archiveMode: "unsafeReference" as const, createdAt: "2026-10-02T19:00:00.000Z", expectedFenceVersion: 1,
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }] };
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "reviewed-export" }) };
  const archive = value(await buildPostgresFencedTenantConfigArchive(db, request, exportAuthority));
  value(await new PostgresTenantConfigArchiveImporter(db, undefined, "unsafeReference").stage(archive,
    target.tenantId, "buyer-admin", { authorizeAndRecord: async () => ok({ auditRef: "reviewed-import" }) },
    { mapRef: (kind, ref) => `buyer:${kind}:${ref}` }));
  const unproven = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, true, "unsafeReference");
  assert.notEqual(value(await unproven.read(target)).capabilities.transfer, "execute");
  const phoneIndex = new PostgresPatientPhoneIndex(db);
  value(await phoneIndex.publish(target, [], "61", "a".repeat(64)));
  const cutover = new PostgresConfigNumberCutover(db);
  const command = { accountRef, dialedNumber, actorRef: "route-admin" };
  const routeAuthority = { authorizeAndRecord: async () => ok({ auditRef: `reviewed-route-${randomUUID()}` }) };
  value(await cutover.stage({ ...command, expectedRouteVersion: 1,
    targetPhoneIndex: { countryCallingCode: "61", maxAgeMs: 30 * 60_000 }, baseline: archive,
    comparison: { ...request, archiveId: `staffed-comparison-${suffix}` } }, routeAuthority, exportAuthority));
  async function denyChangedTarget() {
    assert.deepEqual(await cutover.publish(command, routeAuthority), { ok: false, error: { kind: "targetNotReady" } });
    assert.equal(value(await new PostgresNumberRoutingHost(db).identifyCall(accountRef, dialedNumber)).tenantId, source.tenantId);
  }
  const original = (await sql<{ policy: unknown; previous_staffed_destination_ref: string | null; changed_by: string | null }>`
    select policy, previous_staffed_destination_ref, changed_by from clinic_settings
    where tenant_id = ${target.tenantId} and version = 2`.execute(db)).rows[0];
  assert.ok(original);
  assert.equal(original.previous_staffed_destination_ref, "buyer:transferDestination:host/desk-a");
  await sql`update clinic_settings set previous_staffed_destination_ref = 'wrong-public-route'
    where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await denyChangedTarget();
  await sql`update clinic_settings set previous_staffed_destination_ref = ${original.previous_staffed_destination_ref}
    where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await sql`update clinic_settings set policy = jsonb_set(policy, '{transferDestinationRef}', '"wrong-public-route"'::jsonb)
    where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await denyChangedTarget();
  await sql`update clinic_settings set policy = ${JSON.stringify(original.policy)}::jsonb
    where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await sql`update clinic_settings set changed_by = 'wrong-public-owner'
    where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await denyChangedTarget();
  await sql`update clinic_settings set changed_by = ${original.changed_by}
    where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy, setting_kind,
    previous_staffed_destination_ref, changed_by, changed_at)
    select tenant_id, clinic_id, 'unlisted', version,
      jsonb_set(jsonb_set(policy, '{scope,locationId}', '"unlisted"'::jsonb), '{greeting,scope,locationId}', '"unlisted"'::jsonb),
      setting_kind, previous_staffed_destination_ref, changed_by, changed_at
    from clinic_settings where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await denyChangedTarget();
  await sql`delete from clinic_settings where tenant_id = ${target.tenantId} and location_id = 'unlisted'`.execute(db);
  assert.equal(value(await cutover.publish(command, routeAuthority)).activeTenantId, target.tenantId);
  const history = value(await unproven.listStaffedDestinationChanges(target));
  assert.deepEqual(history.entries.map(row => [row.version, row.destinationRef, row.previousDestinationRef]),
    [["1", "buyer:transferDestination:host/desk-a", null], ["2", "buyer:transferDestination:host/desk-b", "buyer:transferDestination:host/desk-a"]]);
});
