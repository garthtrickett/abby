import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { ok } from "../../src/core/model.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresFinancialEffectBarrier } from "../../src/storage/postgres-financial-effect-barrier.ts";
import { PostgresConfirmationResendJournal } from "../../src/storage/postgres-confirmation-resend-journal.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { buildPostgresTenantConfigArchive } from "../../src/storage/postgres-config-archive.ts";
import { PostgresTenantConfigArchiveImporter } from "../../src/storage/postgres-tenant-config-import.ts";
import { PostgresPortabilityFence } from "../../src/storage/postgres-portability-fence.ts";
import { decodeTenantConfigArchive } from "../../src/portability/config-archive.ts";
import { validStaffWorkHistoryManifest } from "../../src/portability/staff-work-history.ts";
import { down } from "../../src/storage/migrations/049_financial_effect_barriers.ts";
import { withDisposablePostgres } from "../support/disposable-postgres.ts";
import { targetReady } from "../../src/storage/postgres-cutover-target.ts";
import type { TargetImportRow } from "../../src/storage/postgres-cutover-target.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = connectPostgres(process.env.DATABASE_URL);
after(async () => { await db.destroy(); });
const scope = () => ({ tenantId: `financial-${randomUUID()}`, clinicId: "clinic", locationId: "location" });
const binding = "a".repeat(64), now = () => new Date().toISOString();
function value<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T { assert.ok(r.ok, JSON.stringify(r)); return r.value; }
const exportAuthority = { authorizeAndRecord: async () => ok({ requestRef: `financial-export-${randomUUID()}` }) };
const importAuthority = { authorizeAndRecord: async () => ok({ auditRef: `financial-import-${randomUUID()}` }) };
const mapper = { mapRef: () => "disabled" };
async function cutoverReady(tenantId: string): Promise<boolean> {
  return db.transaction().execute(async trx => {
    await sql`select pg_advisory_xact_lock(172934501, hashtext(${tenantId}))`.execute(trx);
    const row = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history
      from tenant_config_imports where target_tenant_id = ${tenantId}`.execute(trx)).rows[0];
    return row !== undefined && targetReady(trx, row.source_history, row);
  });
}

test("financial effect races and fresh owners consume exactly one permanently retained opaque ID", async () => {
  const owner = scope(), ref = randomUUID();
  const results = await Promise.all(Array.from({ length: 16 }, () => new PostgresFinancialEffectBarrier(db, owner, binding).claimOnce(ref)));
  assert.equal(results.filter(r => r.ok && r.value.claimed).length, 1);
  assert.equal(results.filter(r => r.ok && !r.value.claimed).length, 15);
  assert.deepEqual(await new PostgresFinancialEffectBarrier(db, owner, binding).claimOnce(ref), ok({ claimed: false }));
  const rows = (await sql<Record<string, unknown>>`select * from financial_effect_barriers where tenant_id = ${owner.tenantId}`.execute(db)).rows;
  assert.equal(rows.length, 1); assert.deepEqual(Object.keys(rows[0]!).sort(), ["claimed_at", "clinic_id", "effect_ref", "location_id", "owner_binding", "tenant_id"]);
  for (const bad of ["private-patient-canary", "cs_private-payment-canary", "private-recipient@example.invalid"]) {
    assert.deepEqual(await new PostgresFinancialEffectBarrier(db, owner, binding).claimOnce(bad), { ok: false, error: { kind: "invalidInput" } });
    assert.equal(JSON.stringify(rows).includes(bad), false);
  }
  for (const changed of [{ ...owner, clinicId: "other" }, { ...owner, locationId: "other" }]) {
    assert.deepEqual(await new PostgresFinancialEffectBarrier(db, changed, binding).claimOnce(ref), { ok: false, error: { kind: "bindingMismatch" } });
  }
  assert.deepEqual(await new PostgresFinancialEffectBarrier(db, owner, "b".repeat(64)).claimOnce(ref), { ok: false, error: { kind: "bindingMismatch" } });
  await assert.rejects(() => db.transaction().execute(trx => down(trx)), /financial effect barriers/);
});

test("financial barrier writes participate in the real portability freeze", async () => {
  const owner = scope(), fence = new PostgresPortabilityFence(db);
  value(await new PostgresFinancialEffectBarrier(db, owner, binding).claimOnce(randomUUID()));
  const frozen = await fence.freeze({ tenantId: owner.tenantId, actorRef: "fixture-owner", reason: "cutoverFreeze" },
    { authorizeAndRecord: async () => ok({ requestRef: `financial-freeze-${randomUUID()}` }) });
  assert.ok(frozen.ok, JSON.stringify(frozen));
  assert.deepEqual(await new PostgresFinancialEffectBarrier(db, owner, binding).claimOnce(randomUUID()), { ok: false, error: { kind: "storageFailure" } });
});

test("mixed financial and resend barriers survive durable import, repeated staging and a second mapped export", async () => {
  const source = scope(), target = { ...scope(), clinicId: "buyer" }, next = { ...scope(), clinicId: "third" };
  const store = new PostgresPolicyStore(db, referenceDefaultPolicy);
  value(await store.changeBookingEnabled(source, "0", true, "fixture-owner"));
  const ref = randomUUID(), mailRef = randomUUID();
  value(await new PostgresFinancialEffectBarrier(db, source, binding).claimOnce(ref));
  value(await new PostgresConfirmationResendJournal(db, source, binding).claim(mailRef));
  const archive = value(await buildPostgresTenantConfigArchive(db, { sourceTenantId: source.tenantId,
    archiveId: `financial-archive-${randomUUID()}`, actorRef: "fixture-owner", createdAt: now(),
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "fixture-reviewed" }] }, exportAuthority));
  const decoded = value(await decodeTenantConfigArchive(archive, target.tenantId));
  assert.equal(validStaffWorkHistoryManifest(decoded), true);
  assert.equal(decoded.locations[0]?.financialEffects?.[0]?.effectRef, ref);
  assert.equal(decoded.locations[0]?.confirmationResends?.[0]?.requestRef, mailRef);
  const importer = new PostgresTenantConfigArchiveImporter(db);
  assert.equal(value(await importer.preflight(archive, target.tenantId, "fixture-owner", importAuthority, mapper)).status, "ready");
  const receipt = value(await importer.stage(archive, target.tenantId, "fixture-owner", importAuthority, mapper));
  assert.equal(receipt.status, "staged");
  assert.deepEqual(value(await importer.stage(archive, target.tenantId, "fixture-owner", importAuthority, mapper)), receipt);
  assert.equal(value(await importer.preflight(archive, target.tenantId, "fixture-owner", importAuthority, mapper)).status, "alreadyStaged");
  assert.equal(await cutoverReady(target.tenantId), true);
  const policyRow = (await sql<{ version: number; policy: unknown }>`select version, policy from clinic_settings
    where tenant_id = ${target.tenantId} and clinic_id = ${target.clinicId} and location_id = ${target.locationId}
    order by version limit 1`.execute(db)).rows[0]!;
  await sql`update clinic_settings set policy = policy || '{"capabilities":{"book":"write"}}'::jsonb
    where tenant_id = ${target.tenantId} and version = ${policyRow.version}`.execute(db);
  assert.equal(await cutoverReady(target.tenantId), false);
  await sql`update clinic_settings set policy = ${JSON.stringify(policyRow.policy)}::jsonb
    where tenant_id = ${target.tenantId} and version = ${policyRow.version}`.execute(db);
  assert.equal(await cutoverReady(target.tenantId), true);
  assert.deepEqual(await new PostgresFinancialEffectBarrier(db, target, binding).claimOnce(ref), ok({ claimed: false }));
  assert.equal(value(await new PostgresConfirmationResendJournal(db, target, binding).claim(mailRef)).send, false);
  const second = value(await buildPostgresTenantConfigArchive(db, { sourceTenantId: target.tenantId,
    archiveId: `financial-second-${randomUUID()}`, actorRef: "fixture-owner", createdAt: now(),
    locations: [{ sourceScope: target, targetScope: next, timeZone: "UTC", mappingProvenance: "fixture-second" }] }, exportAuthority));
  const secondData = value(await decodeTenantConfigArchive(second, next.tenantId));
  assert.deepEqual(secondData.locations[0]?.financialEffects?.[0]?.originScope, source);
  assert.equal(validStaffWorkHistoryManifest(secondData), true);
  assert.equal(value(await importer.stage(second, next.tenantId, "fixture-owner", importAuthority, mapper)).status, "staged");
  assert.deepEqual(await new PostgresFinancialEffectBarrier(db, next, binding).claimOnce(ref), ok({ claimed: false }));
  assert.equal(await cutoverReady(next.tenantId), true);
  value(await new PostgresFinancialEffectBarrier(db, { ...next, locationId: "unexpected" }, binding).claimOnce(randomUUID()));
  assert.equal(await cutoverReady(next.tenantId), false);
  // Actual retained-row loss must invalidate a cached receipt and re-export;
  // neither path may repair it or grant a replacement effect ID.
  await sql`delete from financial_effect_barriers where tenant_id = ${target.tenantId} and effect_ref = ${ref}::uuid`.execute(db);
  assert.equal(await cutoverReady(target.tenantId), false);
  assert.deepEqual(await importer.preflight(archive, target.tenantId, "fixture-owner", importAuthority, mapper), { ok: false, error: { kind: "storageFailure" } });
  assert.deepEqual(await importer.stage(archive, target.tenantId, "fixture-owner", importAuthority, mapper), { ok: false, error: { kind: "storageFailure" } });
  // Removing both the barrier and its retained projection must still fail the
  // original mixed-section digest; a cached receipt cannot sanitize history loss.
  const edited = { ...decoded, locations: decoded.locations.map(location => ({ ...location, financialEffects: [] })) };
  assert.equal(validStaffWorkHistoryManifest(edited), false);
  await sql`update tenant_config_imports set source_history = ${JSON.stringify(edited)}::jsonb where target_tenant_id = ${target.tenantId}`.execute(db);
  assert.equal(await cutoverReady(target.tenantId), false);
  assert.deepEqual(await importer.preflight(archive, target.tenantId, "fixture-owner", importAuthority, mapper), { ok: false, error: { kind: "storageFailure" } });
  const lost = await buildPostgresTenantConfigArchive(db, { sourceTenantId: target.tenantId,
    archiveId: `financial-lost-${randomUUID()}`, actorRef: "fixture-owner", createdAt: now(),
    locations: [{ sourceScope: target, targetScope: scope(), timeZone: "UTC", mappingProvenance: "fixture-review" }] }, exportAuthority);
  assert.deepEqual(lost, { ok: false, error: { kind: "storageCorrupt" } });
});

test("unmapped financial location and a target containing only an effect barrier refuse export/import", async () => {
  const source = scope(), hidden = { ...source, locationId: "unmapped" }, target = scope();
  const store = new PostgresPolicyStore(db, referenceDefaultPolicy);
  value(await store.changeBookingEnabled(source, "0", true, "fixture-owner"));
  value(await new PostgresFinancialEffectBarrier(db, hidden, binding).claimOnce(randomUUID()));
  const request = { sourceTenantId: source.tenantId, archiveId: `financial-scope-${randomUUID()}`, actorRef: "fixture-owner", createdAt: now(),
    locations: [{ sourceScope: source, targetScope: target, timeZone: "UTC", mappingProvenance: "fixture-reviewed" }] };
  assert.deepEqual(await buildPostgresTenantConfigArchive(db, request, exportAuthority), { ok: false, error: { kind: "scopeIncomplete" } });
  const clean = scope(); value(await store.changeBookingEnabled(clean, "0", true, "fixture-owner"));
  const archive = value(await buildPostgresTenantConfigArchive(db, { ...request, sourceTenantId: clean.tenantId,
    locations: [{ ...request.locations[0]!, sourceScope: clean }] }, exportAuthority));
  value(await new PostgresFinancialEffectBarrier(db, target, binding).claimOnce(randomUUID()));
  assert.deepEqual(await new PostgresTenantConfigArchiveImporter(db).preflight(archive, target.tenantId, "fixture-owner", importAuthority, mapper),
    { ok: false, error: { kind: "targetOccupied" } });
});

test("logical database backup preserves consumed barriers and never restores retry permission", async () => {
  await withDisposablePostgres(async (original, originalUrl) => {
    const owner = scope(), ref = randomUUID();
    assert.deepEqual(await new PostgresFinancialEffectBarrier(original, owner, binding).claimOnce(ref), ok({ claimed: true }));
    // Restore schema and data into an empty database, so dump ordering installs
    // guards after COPY rather than bypassing an already installed guard.
    const dump = execFileSync("pg_dump", [originalUrl, "--no-owner", "--no-privileges"], { timeout: 10_000, maxBuffer: 4_000_000 });
    const name = `financial_restore_${randomUUID().replaceAll("-", "")}`;
    await sql.raw(`create database "${name}"`).execute(original);
    const restoredUrl = new URL(originalUrl); restoredUrl.pathname = `/${name}`;
    const restored = connectPostgres(restoredUrl.toString());
    try {
      execFileSync("psql", [restoredUrl.toString(), "-X", "--set=ON_ERROR_STOP=1"], { input: dump, timeout: 10_000, maxBuffer: 4_000_000 });
      assert.deepEqual(await new PostgresFinancialEffectBarrier(restored, owner, binding).claimOnce(ref), ok({ claimed: false }));
      const before = (await sql`select * from financial_effect_barriers`.execute(original)).rows;
      assert.deepEqual((await sql`select * from financial_effect_barriers`.execute(restored)).rows, before);
    } finally { await restored.destroy(); await sql.raw(`drop database "${name}"`).execute(original); }
  });
});
