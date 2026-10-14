import assert from "node:assert/strict";
import { classAttendee, classLink } from "./class-attendance.ts";

/** A native fixture default may hide each inactive state independently. Keep
 * this provider model independent of the reader's query construction. */
export function visibleCaseRows(url: URL, rows: Record<string, unknown>[]) {
  const filters = url.searchParams.getAll("q[]");
  return rows.filter(row => ["archived_at", "cancelled_at", "deleted_at"].every(field => row[field] === null || filters.includes(`${field}:*`)));
}
export function visibleArchivedCase(url: URL, row: Record<string, unknown>) {
  return row.archived_at === null || url.searchParams.getAll("q[]").includes("archived_at:*");
}

/** Mixed linked history across unrelated bookings. Every row remains part of
 * the private case snapshot even when its status excludes it from session use. */
export function addCaseHistory(rows: Record<string, unknown>[], caseId: string, patientId: string,
  total: number, at: string, seed = 900000) {
  assert.ok(Number.isSafeInteger(total) && total >= 1 && total <= 1100);
  const own = () => rows.filter(row => (row.patient_case as { links?: { self?: string } } | undefined)?.links?.self?.endsWith(`/patient_cases/${caseId}`));
  for (let index = own().length; index < total; index++) {
    const row: Record<string, unknown> = { ...classAttendee(String(seed + index), String(seed + 20000 + index), patientId),
      patient_case: classLink("patient_cases", caseId), arrived: null };
    if (index % 4 === 0) row.cancelled_at = at;
    else if (index % 4 === 1) row.arrived = false;
    else if (index % 4 === 2) row.archived_at = at;
    else row.deleted_at = at;
    rows.push(row);
  }
}
