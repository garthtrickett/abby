import { createHash } from "node:crypto";
import type { LocationScope } from "../core/model.ts";

/** Submission barriers, never recipient, appointment, caller proof or message content. */
export type ConfirmationResendArchiveRow = Readonly<{
  requestRef: string;
  ownerBinding: string;
  status: "possiblySent" | "accepted" | "unknown" | "definitiveUnsent";
  messageRef: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Original logical scope of the native review, retained across later transfers. */
  originScope?: LocationScope;
}>;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validResendOriginScope(value: unknown): value is LocationScope {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "clinicId,locationId,tenantId") return false;
  return Object.values(value).every(part => typeof part === "string" && part.trim() === part && part.length > 0 && part.length <= 256 && !/[\p{Cc}\p{Cf}]/u.test(part));
}
function instant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Legacy absence is empty. A present row must match the exact non-patient contract. */
export function validConfirmationResendArchiveHistory(value: unknown): value is readonly ConfirmationResendArchiveRow[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        !["completedAt,createdAt,messageRef,ownerBinding,requestRef,status", "completedAt,createdAt,messageRef,originScope,ownerBinding,requestRef,status"].includes(Object.keys(row).sort().join(",")) ||
        (Object.hasOwn(row, "originScope") && !validResendOriginScope(row.originScope)) ||
        typeof row.requestRef !== "string" || !uuid.test(row.requestRef) || seen.has(row.requestRef) ||
        typeof row.ownerBinding !== "string" || !/^[a-f0-9]{64}$/.test(row.ownerBinding) || !instant(row.createdAt)) return false;
    if (row.status === "possiblySent") {
      if (row.messageRef !== null || row.completedAt !== null) return false;
    } else {
      if (!instant(row.completedAt) || row.completedAt < row.createdAt) return false;
      if (row.status === "accepted") {
        // Preserve a contradictory receipt too; recovery treats a mismatched UUID as unknown.
        if (typeof row.messageRef !== "string" || !uuid.test(row.messageRef)) return false;
      } else if (!["unknown", "definitiveUnsent"].includes(row.status) || row.messageRef !== null) return false;
    }
    seen.add(row.requestRef);
  }
  return true;
}

/** Canonical record bytes are shared by export and retained-receipt verification. */
export function confirmationResendArchiveRecord(scope: LocationScope, row: ConfirmationResendArchiveRow) {
  return { recordVersion: 1 as const,
    recordId: `confirmationResend:${createHash("sha256").update(row.requestRef).digest("hex")}:000000000001`,
    sourceTenantId: scope.tenantId, kind: "confirmationResendSubmission", sourceClinicId: scope.clinicId,
    sourceLocationId: scope.locationId, requestRef: row.requestRef, ownerBinding: row.ownerBinding,
    status: row.status, messageRef: row.messageRef, createdAt: row.createdAt, completedAt: row.completedAt,
    ...(row.originScope === undefined ? {} : { originScope: { tenantId: row.originScope.tenantId,
      clinicId: row.originScope.clinicId, locationId: row.originScope.locationId } }) };
}
/** A relational journal stores the send barrier; origin lives in the audited import history. */
export function confirmationResendBarrier(row: ConfirmationResendArchiveRow): ConfirmationResendArchiveRow {
  const { originScope: _origin, ...barrier } = row; return barrier;
}
