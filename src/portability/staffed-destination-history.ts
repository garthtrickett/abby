import { isDeepStrictEqual } from "node:util";
import type { CallPolicy } from "../core/model.ts";
import { validStaffedDestinationRef } from "../core/staffed-destination.ts";

type PolicyHistoryRow = Readonly<{ version: number; policy: CallPolicy; settingKind?: string;
  previousStaffedDestinationRef?: string | null; changedBy: string | null; changedAt: string | null }>;

/** Route history changes one public setting. Captured host permission is never portable authority. */
export function validStaffedDestinationHistory(rows: readonly PolicyHistoryRow[]): boolean {
  const ordered = [...rows].sort((left, right) => left.version - right.version);
  for (const [index, row] of ordered.entries()) {
    const ref = row.policy.transferDestinationRef;
    if ((ref !== undefined && !validStaffedDestinationRef(ref)) || row.policy.transferDestinationVersion !== undefined) return false;
    const previous = ordered[index - 1];
    if (row.settingKind !== "staffedDestination") {
      if (row.previousStaffedDestinationRef != null || (previous && ref !== previous.policy.transferDestinationRef)) return false;
      continue;
    }
    if (!previous || row.version === 0 || !Object.hasOwn(row, "previousStaffedDestinationRef") ||
        row.previousStaffedDestinationRef !== (previous.policy.transferDestinationRef ?? null) ||
        !validStaffedDestinationRef(row.changedBy) || !row.changedAt || !Number.isFinite(Date.parse(row.changedAt))) return false;
    const { transferDestinationRef: currentRef, ...unchanged } = row.policy;
    void currentRef;
    if (!isDeepStrictEqual({ ...unchanged, policyVersion: previous.policy.policyVersion,
      ...(previous.policy.transferDestinationRef === undefined ? {} : { transferDestinationRef: previous.policy.transferDestinationRef }) }, previous.policy)) return false;
  }
  return true;
}
