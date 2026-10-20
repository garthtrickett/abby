import type { ClinikoClassSession } from "./class-attendance-read.ts";
import { CLINIKO_CLASS_COLLECTION_PAGE_LIMIT, CLINIKO_CLASS_METADATA_REQUEST_LIMIT } from "./class-attendance-read.ts";
import { CLINIKO_CASE_ASSOCIATION_LIMIT } from "./patient-case-sessions.ts";
import type { ClassMovementStage } from "../core/class-movement-progress.ts";

export type ClassMoveStageRequestCosts = Readonly<{ proof: number; permit: number; passSelect: number; passAllow: number }>;
export type ClassMoveStageRequestCeilings = Readonly<Partial<Record<ClassMovementStage, number>>>;

/** Complete per-stage ceilings for the bounded native implementation. Class
 * metadata uses at most13 requests, each selected roster at most5 pages, and
 * each case at most10 pages. Counts include both stable snapshots, every
 * before/after proof/permit, journal binding and separate compensation stages.
 * Global reader caps cover concurrent page growth; no observed-size estimate
 * or request floor supplies an upper bound. Injected callback costs must be
 * independently complete for the same native account and physical budget. */
export function classMoveStageRequestCeilings(input: unknown, pass: boolean): ClassMoveStageRequestCeilings | undefined {
  try { return readStageRequestCeilings(input, pass); } catch { return undefined; }
}
function readStageRequestCeilings(input: unknown, pass: boolean): ClassMoveStageRequestCeilings | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return undefined;
  const fields = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(fields);
  if (keys.length !== 4 || keys.some(key => typeof key !== "string" || !["proof", "permit", "passSelect", "passAllow"].includes(key))) return undefined;
  const costs: number[] = [];
  for (const name of ["proof", "permit", "passSelect", "passAllow"]) {
    const field = fields[name];
    if (!field || !Object.hasOwn(field, "value") || !field.enumerable || !Number.isSafeInteger(field.value) || field.value < 0 || field.value > 200) return undefined;
    costs.push(field.value);
  }
  const [proof, permit, select, allow] = costs as [number, number, number, number];
  // A pair may use different services: each full observation repeats metadata,
  // the exact occurrence GET and all five roster pages, for both services.
  const destination = 2 * (CLINIKO_CLASS_METADATA_REQUEST_LIMIT + 1 + CLINIKO_CLASS_COLLECTION_PAGE_LIMIT), pair = 2 * destination,
    cases = 2 * (2 * (1 + Math.ceil(CLINIKO_CASE_ASSOCIATION_LIMIT / 100)));
  type Counts = readonly [native: number, proof: number, permit: number, select: number, allow: number];
  const phases: Partial<Record<ClassMovementStage, Counts>> = pass ? {
    replacement: [pair + cases + 5, 7, 13, 10, 5],
    original: [pair + cases + 6, 8, 12, 7, 2],
    association: [destination + cases + 5, 6, 11, 5, 5],
    associationInspection: [destination + cases + 3, 6, 8, 6, 6],
    compensation: [pair + cases + 5, 6, 11, 7, 2],
    compensationInspection: [pair + cases + 5, 6, 11, 7, 2],
  } : {
    replacement: [2 * pair + 4, 9, 9, 0, 0],
    original: [2 * pair + 4, 10, 10, 0, 0],
    compensation: [pair + 3, 7, 7, 0, 0],
    compensationInspection: [pair + 3, 10, 8, 0, 0],
  };
  const result: Partial<Record<ClassMovementStage, number>> = {};
  for (const [name, [native, p, guard, s, a]] of Object.entries(phases) as [ClassMovementStage, Counts][]) {
    const ceiling = native + p * proof + guard * permit + s * select + a * allow;
    if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 180) return undefined;
    result[name] = ceiling;
  }
  return Object.freeze(result);
}

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
