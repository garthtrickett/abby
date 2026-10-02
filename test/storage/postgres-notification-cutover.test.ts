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
import { PostgresClinicNotificationSettingStore } from "../../src/storage/postgres-clinic-notification-settings.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { notificationRegistry } from "../support/notification-settings-contract.ts";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
function value<T>(result: Result<T, { kind: string }>): T { assert.ok(result.ok, result.ok ? "" : result.error.kind); return result.value; }

test("E2E-257 SET-009 complete notification history and explicit target clears reconcile before number publication", async () => {
  const suffix = randomUUID();
  const source = { tenantId: `notification-cutover-source-${suffix}`, clinicId: "clinic", locationId: "main" };
  const target = { ...source, tenantId: `notification-cutover-target-${suffix}` };
  const accountRef = `notification-account-${suffix}`;
  const dialedNumber = "+6125550199";
  await sql`insert into number_routes (account_ref, dialed_number, version, assignment) values
    (${accountRef}, ${dialedNumber}, 1, ${JSON.stringify({ tenantId: source.tenantId, clinicId: source.clinicId, candidateLocationIds: [source.locationId] })}::jsonb)`.execute(db);
  value(await new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, "unsafeReference")
    .changeBookingEnabled(source, "0", false, "source-owner"));
  value(await new PostgresClinicNotificationSettingStore(db, notificationRegistry()).changeOwner(source, "0", "bookingConfirmation", "host", "source-owner"));
  value(await new PostgresPortabilityFence(db).freeze({ tenantId: source.tenantId, actorRef: "owner", reason: "cutoverFreeze" },
    { authorizeAndRecord: async () => ok({ requestRef: "reviewed-freeze" }) }));
  const request = { sourceTenantId: source.tenantId, archiveId: `notifications-fenced-${suffix}`, actorRef: "owner",
    archiveMode: "unsafeReference" as const, createdAt: "2026-10-02T22:00:00.000Z", expectedFenceVersion: 1,
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "reviewed" }] };
  const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: "reviewed-export" }) };
  const archive = value(await buildPostgresFencedTenantConfigArchive(db, request, exportAuthority));
  value(await new PostgresTenantConfigArchiveImporter(db, undefined, "unsafeReference").stage(archive, target.tenantId, "owner",
    { authorizeAndRecord: async () => ok({ auditRef: "reviewed-import" }) }, { mapRef: (kind, ref) => `buyer:${kind}:${ref}` }));
  const unproven = new PostgresPolicyStore(db, referenceDefaultPolicy, "execute", undefined, false, "unsafeReference");
  assert.deepEqual(value(await unproven.read(target)).notificationBindings, {});
  value(await new PostgresPatientPhoneIndex(db).publish(target, [], "61", "a".repeat(64)));
  const cutover = new PostgresConfigNumberCutover(db);
  const command = { accountRef, dialedNumber, actorRef: "owner" };
  const routeAuthority = { authorizeAndRecord: async () => ok({ auditRef: `reviewed-route-${randomUUID()}` }) };
  value(await cutover.stage({ ...command, expectedRouteVersion: 1,
    targetPhoneIndex: { countryCallingCode: "61", maxAgeMs: 30 * 60_000 }, baseline: archive,
    comparison: { ...request, archiveId: `notifications-comparison-${suffix}` } }, routeAuthority, exportAuthority));
  async function deny() {
    assert.deepEqual(await cutover.publish(command, routeAuthority), { ok: false, error: { kind: "targetNotReady" } });
    assert.equal(value(await new PostgresNumberRoutingHost(db).identifyCall(accountRef, dialedNumber)).tenantId, source.tenantId);
  }
  const original = (await sql<{ changed_by: string; changed_at: Date }>`select changed_by, changed_at from clinic_notification_settings
    where tenant_id = ${target.tenantId} and version = 2`.execute(db)).rows[0]!;
  await sql`update clinic_notification_settings set changed_by = 'wrong-clear-owner' where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await deny();
  await sql`update clinic_notification_settings set changed_by = ${original.changed_by} where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await sql`update clinic_notification_settings set changed_at = changed_at + interval '1 second' where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await deny();
  await sql`update clinic_notification_settings set changed_at = ${original.changed_at} where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await sql`update clinic_notification_settings set previous_owner = 'abby' where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await deny();
  await sql`update clinic_notification_settings set previous_owner = 'host' where tenant_id = ${target.tenantId} and version = 2`.execute(db);
  await sql`insert into clinic_notification_settings (tenant_id, clinic_id, version, owners)
    select tenant_id, 'unlisted', version, owners from clinic_notification_settings where tenant_id = ${target.tenantId} and version = 0`.execute(db);
  await deny();
  await sql`delete from clinic_notification_settings where tenant_id = ${target.tenantId} and clinic_id = 'unlisted'`.execute(db);
  assert.equal(value(await cutover.publish(command, routeAuthority)).activeTenantId, target.tenantId);
  assert.deepEqual(value(await unproven.listNotificationChanges(target)).entries.map(row => [row.version, row.owner, row.previousOwner]),
    [["1", "host", null], ["2", null, "host"]]);
  assert.equal(value(await unproven.read(target)).notificationSettings?.owners.bookingConfirmation, null);
});
