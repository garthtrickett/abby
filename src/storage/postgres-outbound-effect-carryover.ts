import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { LocationScope } from "../core/model.ts";
import { outboundEffectBarrierRow, validOutboundEffectHistory, validOutboundEffectScope } from "../portability/outbound-effect-history.ts";
import type { OutboundEffectArchiveRow } from "../portability/outbound-effect-history.ts";
import { validStaffWorkHistoryManifest } from "../portability/staff-work-history.ts";
import type { TenantConfigArchiveData } from "../portability/config-archive.ts";
import { receiptMatches } from "./postgres-cutover-target.ts";
import type { TargetImportRow } from "./postgres-cutover-target.ts";
import type Database from "./generated/Database.ts";

type Db = Kysely<Database> | Transaction<Database>;
export type ScopedOutboundEffectHistory = Readonly<{ clinicId: string; locationId: string; barrier: OutboundEffectArchiveRow }>;
export async function readOutboundEffectCarryover(db: Db, tenantId: string): Promise<readonly ScopedOutboundEffectHistory[]> {
  const rows = (await sql<{ clinic_id: string; location_id: string; effect_ref: string; owner_binding: string; claimed_at: Date }>`select
    clinic_id, location_id, effect_ref, owner_binding, claimed_at from outbound_effect_barriers
    where tenant_id = ${tenantId} order by effect_ref`.execute(db)).rows;
  const history: unknown = rows.map(r => ({ effectRef: r.effect_ref, ownerBinding: r.owner_binding, claimedAt: r.claimed_at.toISOString() }));
  if (!validOutboundEffectHistory(history) || history === undefined) throw new Error("invalid outbound barrier history");
  return rows.map((r, i) => ({ clinicId: r.clinic_id, locationId: r.location_id, barrier: history[i]! }));
}
export async function writeOutboundEffectCarryover(trx: Transaction<Database>, scope: LocationScope,
                                                  rows: readonly OutboundEffectArchiveRow[] | undefined): Promise<void> {
  if (!validOutboundEffectHistory(rows)) throw new Error("invalid outbound barrier history");
  for (const row of rows ?? []) {
    await sql`insert into outbound_effect_barriers (tenant_id, clinic_id, location_id, effect_ref, owner_binding, claimed_at)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${row.effectRef}::uuid,
        ${row.ownerBinding}, ${row.claimedAt}::timestamptz)`.execute(trx);
  }
}
/** Full target comparison, including unmapped/foreign extra rows. Never repairs. */
export async function reconcileOutboundEffectCarryover(db: Db, data: TenantConfigArchiveData): Promise<boolean> {
  if (!validStaffWorkHistoryManifest(data)) return false;
  const expected: ScopedOutboundEffectHistory[] = [];
  for (const location of data.locations) {
    if (!validOutboundEffectHistory(location.outboundEffects)) return false;
    for (const barrier of location.outboundEffects ?? []) expected.push({ clinicId: location.targetScope.clinicId,
      locationId: location.targetScope.locationId, barrier: outboundEffectBarrierRow(barrier) });
  }
  expected.sort((a, b) => a.barrier.effectRef.localeCompare(b.barrier.effectRef));
  return isDeepStrictEqual(await readOutboundEffectCarryover(db, data.targetTenantId), expected);
}

type ImportedEffect = Readonly<{ target: LocationScope; origin: LocationScope; barrier: OutboundEffectArchiveRow }>;
/** Current retained receipt and canonical mixed section, never a caller mapping. */
async function importedEffects(db: Db, tenantId: string): Promise<ReadonlyMap<string, ImportedEffect>> {
  const registry = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history
    from tenant_config_imports where target_tenant_id = ${tenantId}`.execute(db)).rows[0];
  const result = new Map<string, ImportedEffect>();
  if (!registry) return result;
  const data = registry.source_history;
  if (!receiptMatches(registry, data) || data.targetTenantId !== tenantId || !validStaffWorkHistoryManifest(data) ||
      data.locations.length < 1 || data.locations.length > 16) throw new Error("invalid outbound barrier import receipt");
  const sources = new Set<string>(), targets = new Set<string>();
  for (const location of data.locations) {
    if (!validOutboundEffectScope(location.sourceScope) || !validOutboundEffectScope(location.targetScope) ||
        location.sourceScope.tenantId !== data.sourceTenantId || location.targetScope.tenantId !== tenantId ||
        !validOutboundEffectHistory(location.outboundEffects)) throw new Error("invalid outbound barrier import mapping");
    const source = JSON.stringify([location.sourceScope.tenantId, location.sourceScope.clinicId, location.sourceScope.locationId]);
    const target = JSON.stringify([location.targetScope.tenantId, location.targetScope.clinicId, location.targetScope.locationId]);
    if (sources.has(source) || targets.has(target)) throw new Error("ambiguous outbound barrier import mapping");
    sources.add(source); targets.add(target);
    for (const row of location.outboundEffects ?? []) {
      if (result.has(row.effectRef)) throw new Error("ambiguous outbound barrier import reference");
      result.set(row.effectRef, { target: location.targetScope, origin: row.originScope ?? location.sourceScope, barrier: outboundEffectBarrierRow(row) });
    }
  }
  return result;
}

/** A known consumed imported ID may never be recreated after native-row loss.
 * Invalid retained metadata also blocks a new claim. This does not prove absence
 * of attempts newer than a backup: independent producer admission is still needed. */
export async function outboundEffectWasImported(db: Db, tenantId: string, effectRef: string): Promise<boolean> {
  return (await importedEffects(db, tenantId)).has(effectRef);
}

/** Re-export verifies every retained imported barrier and carries original scope.
 * Additional locally claimed effects keep their current ownership. */
export async function carryOutboundEffectOrigins(db: Db, tenantId: string,
  current: readonly ScopedOutboundEffectHistory[]): Promise<readonly ScopedOutboundEffectHistory[]> {
  const imported = await importedEffects(db, tenantId), actual = new Map(current.map(row => [row.barrier.effectRef, row]));
  for (const [ref, binding] of imported) {
    const retained = actual.get(ref);
    if (!retained || retained.clinicId !== binding.target.clinicId || retained.locationId !== binding.target.locationId ||
        !isDeepStrictEqual(retained.barrier, binding.barrier)) throw new Error("lost outbound barrier import history");
  }
  return current.map(row => {
    const binding = imported.get(row.barrier.effectRef);
    return binding ? { ...row, barrier: { ...row.barrier, originScope: structuredClone(binding.origin) } } : row;
  });
}
