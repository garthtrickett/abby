import type { ClinikoBudgetDenial } from "./read-budget.ts";

export const reservationLifetimeMs = 30_000;
export type BudgetHold = Readonly<{ id: string; remaining: number; expiresAt: number }>;
export type BudgetState = Readonly<{ now: number; limit: number; cooldown: number; recent: readonly number[]; holds: readonly BudgetHold[] }>;

/** Validate physical state independently of a caller's allocation context. */
export function validateBudgetState(s: BudgetState): void {
  if (!Number.isSafeInteger(s.now) || s.now < 0 || !Number.isSafeInteger(s.limit) || s.limit < 1 || s.limit > 200 ||
      !Number.isSafeInteger(s.cooldown) || s.cooldown < 0 || s.recent.length > 200 || s.holds.length > 200 ||
      s.recent.some((at, i) => !Number.isSafeInteger(at) || at > s.now || at <= s.now - 60_000 || at < 0 || i > 0 && at < s.recent[i - 1]!) ||
      new Set(s.holds.map(h => h.id)).size !== s.holds.length || s.holds.some(h => !/^[0-9a-f-]{36}$/.test(h.id) ||
        !Number.isSafeInteger(h.remaining) || h.remaining < 0 || h.remaining > s.limit ||
        !Number.isSafeInteger(h.expiresAt) || h.expiresAt <= s.now || h.expiresAt > s.now + reservationLifetimeMs) ||
      s.recent.length + s.holds.reduce((n, h) => n + h.remaining, 0) > s.limit) throw new Error("invalid Cliniko allocation state");
}

/** An owner's claims consume its held balance. Other consumers can use only
 * unallocated capacity. Retry times reflect both sends and expiring holds. */
export function budgetCapacity(s: BudgetState, requests: number, owner?: string): ClinikoBudgetDenial | null {
  validateBudgetState(s);
  if (!Number.isSafeInteger(requests) || requests < 1 || requests > s.limit) return { kind: "unavailable" };
  if (s.now < s.cooldown) return { kind: "rateLimited", resetAt: new Date(s.cooldown).toISOString(), retryAfterMs: s.cooldown - s.now };
  if (owner !== undefined) return s.holds.some(h => h.id === owner && h.remaining >= requests) ? null : { kind: "unavailable" };
  let occupied = s.recent.length + s.holds.reduce((n, h) => n + h.remaining, 0);
  if (occupied + requests <= s.limit) return null;
  const events = [...s.recent.map(at => ({ at: at + 60_000, freed: 1 })), ...s.holds.map(h => ({ at: h.expiresAt, freed: h.remaining }))].sort((a, b) => a.at - b.at);
  for (const event of events) {
    occupied -= event.freed;
    if (occupied + requests <= s.limit) return { kind: "rateLimited", resetAt: new Date(event.at).toISOString(), retryAfterMs: event.at - s.now };
  }
  return { kind: "unavailable" };
}

/** Existing single-request failures keep their public shape. Relative wait
 * belongs to admission/headroom, not an extra provider response field. */
export function claimDenial(value: ClinikoBudgetDenial | null): ClinikoBudgetDenial | null {
  return value?.kind === "rateLimited" ? { kind: "rateLimited", ...(value.resetAt ? { resetAt: value.resetAt } : {}) } : value;
}
