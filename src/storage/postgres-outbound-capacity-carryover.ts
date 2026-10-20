import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type { LocationScope } from "../core/model.ts";
import { outboundCapacityAllocationRow, validOutboundCapacityHistory } from "../portability/outbound-capacity-history.ts";
import type { OutboundCapacityArchiveRow } from "../portability/outbound-capacity-history.ts";
import { validOutboundEffectScope } from "../portability/outbound-effect-history.ts";
import { validStaffWorkHistoryManifest } from "../portability/staff-work-history.ts";
import type { TenantConfigArchiveData } from "../portability/config-archive.ts";
import { receiptMatches } from "./postgres-cutover-target.ts";
import type { TargetImportRow } from "./postgres-cutover-target.ts";
import type Database from "./generated/Database.ts";

type Db = Kysely<Database> | Transaction<Database>;
export type ScopedOutboundCapacityHistory = Readonly<{ clinicId: string; locationId: string; allocation: OutboundCapacityArchiveRow }>;
export async function readOutboundCapacityCarryover(db: Db, tenantId: string): Promise<readonly ScopedOutboundCapacityHistory[]> {
  const rows = (await sql<{ clinic_id: string; location_id: string; allocation_ref: string; owner_binding: string; acquired_at: Date; released_at: Date | null }>`select
    clinic_id, location_id, allocation_ref, owner_binding, acquired_at, released_at from outbound_capacity_allocations
    where tenant_id = ${tenantId} order by allocation_ref`.execute(db)).rows;
  const history: unknown = rows.map(r => ({ allocationRef: r.allocation_ref, ownerBinding: r.owner_binding,
    acquiredAt: r.acquired_at.toISOString(), releasedAt: r.released_at?.toISOString() ?? null }));
  if (!validOutboundCapacityHistory(history) || history === undefined) throw new Error("invalid outbound capacity history");
  return rows.map((r, i) => ({ clinicId: r.clinic_id, locationId: r.location_id, allocation: history[i]! }));
}
export async function writeOutboundCapacityCarryover(trx: Transaction<Database>, scope: LocationScope,
  rows: readonly OutboundCapacityArchiveRow[] | undefined): Promise<void> {
  if (!validOutboundCapacityHistory(rows)) throw new Error("invalid outbound capacity history");
  for (const row of rows ?? []) await sql`insert into outbound_capacity_allocations
    (tenant_id, clinic_id, location_id, allocation_ref, owner_binding, acquired_at, released_at)
    values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, ${row.allocationRef}::uuid, ${row.ownerBinding},
      ${row.acquiredAt}::timestamptz, ${row.releasedAt}::timestamptz)`.execute(trx);
}
export async function reconcileOutboundCapacityCarryover(db: Db, data: TenantConfigArchiveData): Promise<boolean> {
  if (!validStaffWorkHistoryManifest(data)) return false;
  const expected: ScopedOutboundCapacityHistory[] = [];
  for (const location of data.locations) {
    if (!validOutboundCapacityHistory(location.outboundCapacity)) return false;
    for (const allocation of location.outboundCapacity ?? []) expected.push({ clinicId: location.targetScope.clinicId,
      locationId: location.targetScope.locationId, allocation: outboundCapacityAllocationRow(allocation) });
  }
  expected.sort((a, b) => a.allocation.allocationRef.localeCompare(b.allocation.allocationRef));
  return isDeepStrictEqual(await readOutboundCapacityCarryover(db, data.targetTenantId), expected);
}
/** Import receipts retain every historical allocation. A held imported row may
 * subsequently release through its trusted owner; a released row cannot revive
 * or acquire a new release timestamp. Missing rows block new occupancy decisions. */
export async function carryOutboundCapacityOrigins(db: Db, tenantId: string,
  current: readonly ScopedOutboundCapacityHistory[]): Promise<readonly ScopedOutboundCapacityHistory[]> {
  const registry = (await sql<TargetImportRow>`select archive_id, manifest_digest, receipt, source_history
    from tenant_config_imports where target_tenant_id = ${tenantId}`.execute(db)).rows[0];
  if (!registry) return current;
  const data = registry.source_history;
  if (!receiptMatches(registry, data) || data.targetTenantId !== tenantId || !validStaffWorkHistoryManifest(data) ||
      data.locations.length < 1 || data.locations.length > 16) throw new Error("invalid outbound capacity import receipt");
  const actual = new Map(current.map(row => [row.allocation.allocationRef, row])), origins = new Map<string, LocationScope>();
  const sources = new Set<string>(), targets = new Set<string>();
  for (const location of data.locations) {
    if (!validOutboundEffectScope(location.sourceScope) || !validOutboundEffectScope(location.targetScope) ||
        location.sourceScope.tenantId !== data.sourceTenantId || location.targetScope.tenantId !== tenantId ||
        !validOutboundCapacityHistory(location.outboundCapacity)) throw new Error("invalid outbound capacity mapping");
    const source = JSON.stringify(location.sourceScope), target = JSON.stringify(location.targetScope);
    if (sources.has(source) || targets.has(target)) throw new Error("ambiguous outbound capacity mapping");
    sources.add(source); targets.add(target);
    for (const row of location.outboundCapacity ?? []) {
      const retained = actual.get(row.allocationRef), a = retained?.allocation;
      if (origins.has(row.allocationRef) || !retained || retained.clinicId !== location.targetScope.clinicId ||
          retained.locationId !== location.targetScope.locationId || !a || a.ownerBinding !== row.ownerBinding ||
          a.acquiredAt !== row.acquiredAt || row.releasedAt !== null && a.releasedAt !== row.releasedAt)
        throw new Error("lost outbound capacity import history");
      origins.set(row.allocationRef, row.originScope ?? location.sourceScope);
    }
  }
  return current.map(row => ({ ...row, allocation: { ...row.allocation,
    ...(origins.has(row.allocation.allocationRef) ? { originScope: structuredClone(origins.get(row.allocation.allocationRef)!) } : {}) } }));
}
