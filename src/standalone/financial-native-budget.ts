import { claimClinikoBudget, checkClinikoHeadroom, observeCliniko429 } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget, ClinikoBudgetDenial } from "../cliniko/read-budget.ts";

/** Polling-only observation of the same physical budget. Preserve every actual
 * claim, headroom check, provider cooldown and reservation; store no work or
 * permission. A full quiet rolling minute allows preparation to recover too. */
export function financialNativeBudget(source: ClinikoRequestBudget, defer: (retryAfterMs: number) => void): ClinikoRequestBudget {
  const observe = <T extends ClinikoBudgetDenial | null>(denial: T): T => {
    if (denial?.kind === "rateLimited") defer(Math.max(60_000, denial.retryAfterMs ?? 60_000));
    return denial;
  };
  return Object.freeze({
    claim: async () => observe(await claimClinikoBudget(source)),
    observe429: async (reset: string | null) => observe(await observeCliniko429(source, reset)),
    ...(source.checkHeadroom ? { checkHeadroom: async (requests: number) => observe(await checkClinikoHeadroom(source, requests)) } : {}),
    // Keep the underlying allocation context: this observer never creates a
    // second budget, silently drops a reservation, or retries its callback.
    ...(source.withReservation ? { withReservation: source.withReservation.bind(source) } : {}),
  });
}
