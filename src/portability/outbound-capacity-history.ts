import { createHash } from "node:crypto";
import type { LocationScope } from "../core/model.ts";
import { validOutboundEffectRef } from "../core/outbound-effect-barrier.ts";
import { validOutboundEffectScope } from "./outbound-effect-history.ts";

export type OutboundCapacityArchiveRow = Readonly<{
  allocationRef: string; ownerBinding: string; acquiredAt: string; releasedAt: string | null; originScope?: LocationScope;
}>;
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function validOutboundCapacityHistory(value: unknown): value is readonly OutboundCapacityArchiveRow[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const refs = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        !["acquiredAt,allocationRef,ownerBinding,releasedAt", "acquiredAt,allocationRef,originScope,ownerBinding,releasedAt"].includes(Object.keys(row).sort().join(",")) ||
        !validOutboundEffectRef(row.allocationRef) || refs.has(row.allocationRef) || typeof row.ownerBinding !== "string" || !/^[a-f0-9]{64}$/.test(row.ownerBinding) ||
        !instant(row.acquiredAt) || row.releasedAt !== null && (!instant(row.releasedAt) || row.releasedAt < row.acquiredAt) ||
        Object.hasOwn(row, "originScope") && !validOutboundEffectScope(row.originScope)) return false;
    refs.add(row.allocationRef);
  }
  return true;
}
export function outboundCapacityArchiveRecord(scope: LocationScope, row: OutboundCapacityArchiveRow) {
  return { recordVersion: 1 as const, recordId: `outboundCapacity:${createHash("sha256").update(row.allocationRef).digest("hex")}:000000000001`,
    sourceTenantId: scope.tenantId, kind: "outboundCapacityAllocation", sourceClinicId: scope.clinicId, sourceLocationId: scope.locationId,
    allocationRef: row.allocationRef, ownerBinding: row.ownerBinding, acquiredAt: row.acquiredAt, releasedAt: row.releasedAt,
    ...(row.originScope === undefined ? {} : { originScope: { ...row.originScope } }) };
}
export function outboundCapacityAllocationRow(row: OutboundCapacityArchiveRow): OutboundCapacityArchiveRow {
  const { originScope: _origin, ...allocation } = row; return allocation;
}
