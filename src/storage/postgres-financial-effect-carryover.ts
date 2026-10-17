import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { LocationScope } from "../core/model.ts";
import { financialEffectBarrierRow, validFinancialEffectHistory, validFinancialEffectScope } from "../portability/financial-effect-history.ts";
import type { FinancialEffectArchiveRow } from "../portability/financial-effect-history.ts";
import { validStaffWorkHistoryManifest } from "../portability/staff-work-history.ts";
import type { TenantConfigArchiveData } from "../portability/config-archive.ts";
import { receiptMatches } from "./postgres-cutover-target.ts";
import type { TargetImportRow } from "./postgres-cutover-target.ts";
import type Database from "./generated/Database.ts";

type Db = Kysely<Database> | Transaction<Database>;
export type ScopedFinancialEffectHistory = Readonly<{ clinicId: string; locationId: string; barrier: FinancialEffectArchiveRow }>;
export async function readFinancialEffectCarryover(db: Db, tenantId: string): Promise<readonly ScopedFinancialEffectHistory[]> {
  const rows = (await sql<{ clinic_id: string; location_id: string; effect_ref: string; owner_binding: string; claimed_at: Date }>`select
    clinic_id, location_id, effect_ref, owner_binding, claimed_at from financial_effect_barriers
    where tenant_id = ${tenantId} order by effect_ref`.execute(db)).rows;
  const history: unknown = rows.map(r => ({ effectRef: r.effect_ref, ownerBinding: r.owner_binding, claimedAt: r.claimed_at.toISOString() }));
  if (!validFinancialEffectHistory(history) || history === undefined) throw new Error("invalid financial barrier history");
  return rows.map((r, i) => ({ clinicId: r.clinic_id, locationId: r.location_id, barrier: history[i]! }));
}
export async function writeFinancialEffectCarryover(trx: Transaction<Database>, scope: LocationScope,
                                                  rows: readonly FinancialEffectArchiveRow[] | undefined): Promise<void> {
  if (!validFinancialEffectHistory(rows)) throw new Error("invalid financial barrier history");
  for (const row of rows ?? []) {
    await sql`insert into financial_effect_barriers (tenant_id, clinic_id, location_id, effect_ref, owner_binding, claimed_at)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${row.effectRef}::uuid,
        ${row.ownerBinding}, ${row.claimedAt}::timestamptz)`.execute(trx);
  }
}
/** Full target comparison, including unmapped/foreign extra rows. Never repairs. */
export async function reconcileFinancialEffectCarryover(db: Db, data: TenantConfigArchiveData): Promise<boolean> {
  if (!validStaffWorkHistoryManifest(data)) return false;
  const expected: ScopedFinancialEffectHistory[] = [];
  for (const location of data.locations) {
    if (!validFinancialEffectHistory(location.financialEffects)) return false;
    for (const barrier of location.financialEffects ?? []) expected.push({ clinicId: location.targetScope.clinicId,
      locationId: location.targetScope.locationId, barrier: financialEffectBarrierRow(barrier) });
  }
  expected.sort((a, b) => a.barrier.effectRef.localeCompare(b.barrier.effectRef));
  return isDeepStrictEqual(await readFinancialEffectCarryover(db, data.targetTenantId), expected);
}

/** Re-export checks audited import receipt, whole mixed staff-work digest and
 * every retained imported barrier before carrying original logical ownership.
 * New locally claimed effects keep their current scope; history is never inferred
 * from a supplied mapping or repaired from an import receipt. */
export async function carryFinancialEffectOrigins(db: Db, tenantId: string,
  current: readonly ScopedFinancialEffectHistory[]): Promise<readonly ScopedFinancialEffectHistory[]> {
  const registry = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history
    from tenant_config_imports where target_tenant_id = ${tenantId}`.execute(db)).rows[0];
  if (!registry) return current;
  const data = registry.source_history;
  if (!receiptMatches(registry, data) || data.targetTenantId !== tenantId || !validStaffWorkHistoryManifest(data) ||
      data.locations.length < 1 || data.locations.length > 16) throw new Error("invalid financial barrier import receipt");
  const origins = new Map<string, LocationScope>(), actual = new Map(current.map(row => [row.barrier.effectRef, row]));
  const sources = new Set<string>(), targets = new Set<string>();
  for (const location of data.locations) {
    if (!validFinancialEffectScope(location.sourceScope) || !validFinancialEffectScope(location.targetScope) ||
        location.sourceScope.tenantId !== data.sourceTenantId || location.targetScope.tenantId !== tenantId ||
        !validFinancialEffectHistory(location.financialEffects)) throw new Error("invalid financial barrier import mapping");
    const source = JSON.stringify(location.sourceScope), target = JSON.stringify(location.targetScope);
    if (sources.has(source) || targets.has(target)) throw new Error("ambiguous financial barrier import mapping");
    sources.add(source); targets.add(target);
    for (const row of location.financialEffects ?? []) {
      if (origins.has(row.effectRef)) throw new Error("ambiguous financial barrier import reference");
      const retained = actual.get(row.effectRef);
      if (!retained || retained.clinicId !== location.targetScope.clinicId || retained.locationId !== location.targetScope.locationId ||
          !isDeepStrictEqual(retained.barrier, financialEffectBarrierRow(row))) throw new Error("lost financial barrier import history");
      origins.set(row.effectRef, row.originScope ?? location.sourceScope);
    }
  }
  return current.map(row => origins.has(row.barrier.effectRef)
    ? { ...row, barrier: { ...row.barrier, originScope: structuredClone(origins.get(row.barrier.effectRef)!) } } : row);
}
