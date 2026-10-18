import { AsyncLocalStorage } from "node:async_hooks";
import { financialExpiryResultCode } from "./financial-expiry-observation.ts";
import type { FinancialExpiryObservation } from "./financial-expiry-observation.ts";
export type ExpiryObservationCounts = { claims: number; requests: number; quotaRequired: number; quotaDenials: number };
export const expiryObservationCounts = new AsyncLocalStorage<ExpiryObservationCounts>();
const count = (v: number, max: number) => Number.isSafeInteger(v) && v >= 0 ? Math.min(max, v) : 0;
/** Test observation never replaces the real result, exception, operation signal,
 * quota claim or acknowledgement. Observer failures are not operation failures. */
export async function observeFinancialExpiry<T>(run: () => Promise<T>, emit: (value: FinancialExpiryObservation) => unknown): Promise<T> {
  const counts: ExpiryObservationCounts = { claims: 0, requests: 0, quotaRequired: 0, quotaDenials: 0 }, began = performance.now();
  let result: T | undefined;
  try { result = await expiryObservationCounts.run(counts, run); return result; }
  finally {
    try { void Promise.resolve(emit(Object.freeze({ code: financialExpiryResultCode(result), claims: count(counts.claims, 65535), requests: count(counts.requests, 65535),
      quotaRequired: count(counts.quotaRequired, 200), quotaDenials: count(counts.quotaDenials, 65535), elapsedMs: count(Math.round(performance.now() - began), 600_000) }))).catch(() => {}); }
    catch { /* Never erase an actual outcome or forward an observer error. */ }
  }
}
