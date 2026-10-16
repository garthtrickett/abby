import type { ClinikoClassSession } from "./class-attendance-read.ts";

/** Requests owned by the pass coordinator's four complete class observations.
 * Forecasts the observed native shape, including the replacement's added row.
 * External proof/permission I/O, concurrent growth, quota reservations and
 * compensation remain separate; this is not an upper bound for arbitrary hosts. */
export function classMoveObservationRequests(source: ClinikoClassSession, destination: ClinikoClassSession, paired: boolean): number | undefined {
  const a = source.nativeWorkload, b = destination.nativeWorkload;
  if (!a || !b || [a, b].some(w => !Number.isSafeInteger(w.metadataRequests) || w.metadataRequests < 5 || w.metadataRequests > 13 ||
      !Number.isSafeInteger(w.attendanceRecords) || w.attendanceRecords < 0 || w.attendanceRecords > 500) ||
      b.attendanceRecords >= 500 || paired && a.metadataRequests !== b.metadataRequests) return undefined;
  const pages = (count: number) => Math.max(1, Math.ceil(count / 100));
  const sourcePages = pages(a.attendanceRecords), before = pages(b.attendanceRecords), after = pages(b.attendanceRecords + 1);
  const pair = (destinationPages: number) => paired ? 2 * (a.metadataRequests + 2 + sourcePages + destinationPages) :
    2 * (a.metadataRequests + 1 + sourcePages) + 2 * (b.metadataRequests + 1 + destinationPages);
  const destinationAfter = 2 * (b.metadataRequests + 1 + after);
  return pair(before) + pair(after) + 2 * destinationAfter;
}

/** Replace only the old single-page class floor in the existing whole-pass
 * estimate. Both inputs come from current private native observations. */
export function observedClassMoveRequests(minimumNativeRequests: number, source: ClinikoClassSession, destination: ClinikoClassSession, paired: boolean): number | undefined {
  const classes = classMoveObservationRequests(source, destination, paired);
  const floor = paired ? 64 : 84;
  if (classes === undefined || !Number.isSafeInteger(minimumNativeRequests) || minimumNativeRequests < floor) return undefined;
  return minimumNativeRequests - floor + classes;
}
