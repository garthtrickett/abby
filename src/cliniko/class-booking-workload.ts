import { CLINIKO_CLASS_COLLECTION_PAGE_LIMIT, CLINIKO_CLASS_METADATA_REQUEST_LIMIT } from "./class-attendance-read.ts";
import { CLINIKO_CASE_ASSOCIATION_LIMIT } from "./patient-case-sessions.ts";

export type ClassFinancialBookingRequestCosts = Readonly<{
  proof: number; ownership: number; permit: number; passSelect: number;
  financialCurrent: number; source: number; recordPermit: number; recordProducer: number;
  capture: 0 | 1;
}>;
export type ClassFinancialBookingRequestPlan = Readonly<{ write: number; confirmation: number }>;

/** Global reader bounds cover concurrent page growth, not just observed sizes.
 * One protected occurrence check precedes review. The post-review check repeats
 * proof/permission/case checks; final dispatch prepares metadata/proof then takes
 * both capacity snapshots. Case history is read three times. Callback ceilings
 * include transitive I/O for this account/budget. Optional post-ACK observation
 * retention is budgeted, but its failure cannot erase the clinical ACK. */
export function classFinancialBookingRequestPlan(input: unknown, pass: boolean): ClassFinancialBookingRequestPlan | undefined {
  try {
    if (typeof pass !== "boolean" || !input || typeof input !== "object" || Array.isArray(input) ||
        Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return undefined;
    const fields = Object.getOwnPropertyDescriptors(input), names = ["proof", "ownership", "permit", "passSelect", "financialCurrent", "source", "recordPermit", "recordProducer", "capture"];
    if (Reflect.ownKeys(fields).length !== names.length) return undefined;
    const values: number[] = [];
    for (const name of names) {
      const field = fields[name];
      if (!field || !Object.hasOwn(field, "value") || !field.enumerable || !Number.isSafeInteger(field.value) || field.value < 0 || field.value > 200) return undefined;
      values.push(field.value);
    }
    const [proof, ownership, permit, select, current, source, recordPermit, producer, capture] = values as [number, number, number, number, number, number, number, number, number];
    if (capture !== 0 && capture !== 1) return undefined;
    const protectedOccurrence = 2 * (CLINIKO_CLASS_METADATA_REQUEST_LIMIT + 1 + CLINIKO_CLASS_COLLECTION_PAGE_LIMIT);
    const dispatchOccurrence = CLINIKO_CLASS_METADATA_REQUEST_LIMIT + 2 * (1 + CLINIKO_CLASS_COLLECTION_PAGE_LIMIT);
    const caseRead = 2 * (1 + Math.ceil(CLINIKO_CASE_ASSOCIATION_LIMIT / 100));
    const native = protectedOccurrence + dispatchOccurrence + 2 + (pass ? 3 * caseRead : 0) + 2 * capture;
    const write = native + (pass ? 16 : 10) * proof + 6 * permit + (pass ? 6 * select : 0) + 2 * current +
      capture * (3 * source + 2 * recordPermit + 2 * producer);
    // The second current check follows the capacity admission observation.
    const confirmation = write + ownership + permit + (pass ? select : 0);
    if (!Number.isSafeInteger(confirmation) || write < 1 || confirmation > 180) return undefined;
    return Object.freeze({ write, confirmation });
  } catch { return undefined; }
}
