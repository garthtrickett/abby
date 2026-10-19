import { AsyncLocalStorage } from "node:async_hooks";
import { financialExpiryResultCode, financialNativeReadCode } from "./financial-expiry-observation.ts";
import type { FinancialExpiryObservation, FinancialNativeReadFailure } from "./financial-expiry-observation.ts";
export type ExpiryObservationCounts = { claims: number; requests: number; quotaRequired: number; quotaDenials: number; nativeFailure?: FinancialNativeReadFailure };
export const expiryObservationCounts = new AsyncLocalStorage<ExpiryObservationCounts>();
const count = (v: number, max: number) => Number.isSafeInteger(v) && v >= 0 ? Math.min(max, v) : 0;
/** Observe a real native reader's negative result without exporting private
 * errors, replacing the result or changing permissions, quota or timing. */
export async function observeFinancialNativeRead<T>(reader: 1 | 2 | 3 | 4, run: () => Promise<T>): Promise<T> {
  const result = await run();
  try {
    const counts = expiryObservationCounts.getStore(), value = result as { ok?: unknown };
    if (counts && value?.ok === false && (!counts.nativeFailure || !counts.nativeFailure.afterClaim && counts.claims > 0))
      counts.nativeFailure = Object.freeze({ reader, code: financialNativeReadCode(result), afterClaim: counts.claims > 0 });
  } catch { /* Observation never alters a native result. */ }
  return result;
}
/** Test observation never replaces the real result, exception, operation signal,
 * quota claim or acknowledgement. Observer failures are not operation failures. */
export async function observeFinancialExpiry<T>(run: () => Promise<T>, emit: (value: FinancialExpiryObservation) => unknown): Promise<T> {
  const counts: ExpiryObservationCounts = { claims: 0, requests: 0, quotaRequired: 0, quotaDenials: 0 }, began = performance.now();
  let result: T | undefined;
  try { result = await expiryObservationCounts.run(counts, run); return result; }
  finally {
    try { void Promise.resolve(emit(Object.freeze({ code: financialExpiryResultCode(result), claims: count(counts.claims, 65535), requests: count(counts.requests, 65535),
      quotaRequired: count(counts.quotaRequired, 200), quotaDenials: count(counts.quotaDenials, 65535), elapsedMs: count(Math.round(performance.now() - began), 600_000), ...(counts.nativeFailure ? { nativeFailure: counts.nativeFailure } : {}) }))).catch(() => {}); }
    catch { /* Never erase an actual outcome or forward an observer error. */ }
  }
}
