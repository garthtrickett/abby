import { createHash } from "node:crypto";
import type { LocationScope } from "../core/model.ts";
import { validFinancialEffectRef } from "../standalone/financial-effect-barrier.ts";

/** No provider/customer/appointment/payment/recipient identifiers or content. */
export type FinancialEffectArchiveRow = Readonly<{
  effectRef: string; ownerBinding: string; claimedAt: string; originScope?: LocationScope;
}>;
export function validFinancialEffectScope(value: unknown): value is LocationScope {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "clinicId,locationId,tenantId") return false;
  return Object.values(value).every(v => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(v));
}
export function validFinancialEffectHistory(value: unknown): value is readonly FinancialEffectArchiveRow[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const refs = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        !["claimedAt,effectRef,ownerBinding", "claimedAt,effectRef,originScope,ownerBinding"].includes(Object.keys(row).sort().join(",")) ||
        !validFinancialEffectRef(row.effectRef) || refs.has(row.effectRef) ||
        typeof row.ownerBinding !== "string" || !/^[a-f0-9]{64}$/.test(row.ownerBinding) ||
        typeof row.claimedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.claimedAt) ||
        !Number.isFinite(Date.parse(row.claimedAt)) || new Date(row.claimedAt).toISOString() !== row.claimedAt ||
        Object.hasOwn(row, "originScope") && !validFinancialEffectScope(row.originScope)) return false;
    refs.add(row.effectRef);
  }
  return true;
}
export function financialEffectArchiveRecord(scope: LocationScope, row: FinancialEffectArchiveRow) {
  return { recordVersion: 1 as const,
    recordId: `financialEffect:${createHash("sha256").update(row.effectRef).digest("hex")}:000000000001`,
    sourceTenantId: scope.tenantId, kind: "financialEffectBarrier", sourceClinicId: scope.clinicId,
    sourceLocationId: scope.locationId, effectRef: row.effectRef, ownerBinding: row.ownerBinding, claimedAt: row.claimedAt,
    ...(row.originScope === undefined ? {} : { originScope: { tenantId: row.originScope.tenantId, clinicId: row.originScope.clinicId, locationId: row.originScope.locationId } }) };
}
export function financialEffectBarrierRow(row: FinancialEffectArchiveRow): FinancialEffectArchiveRow {
  const { originScope: _origin, ...barrier } = row; return barrier;
}
