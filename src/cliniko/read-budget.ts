import { createHash, randomUUID } from "node:crypto";
import { budgetReservationContext, runBudgetReservation } from "./budget-reservation-context.ts";
import { budgetCapacity, claimDenial, reservationLifetimeMs } from "./request-budget-state.ts";
import type { BudgetHold, BudgetState } from "./request-budget-state.ts";

/** Compare a reader and its budget without revealing or persisting the API credential. */
export function clinikoCredentialFingerprint(apiKey: string): string {
  return createHash("sha256").update("abby-cliniko-credential-v1\0").update(apiKey).digest("hex");
}

export type ClinikoRateLimit = Readonly<{ kind: "rateLimited"; resetAt?: string; retryAfterMs?: number }>;
export type ClinikoBudgetDenial = ClinikoRateLimit | Readonly<{ kind: "unavailable" }>;
export type ClinikoBudgetOperationalEvent = "claimRateLimited" | "claimUnavailable" | "provider429";
export type ClinikoReservedRun<T> = Readonly<{ kind: "denied"; denial: ClinikoBudgetDenial }> |
  Readonly<{ kind: "completed"; value: T }> | Readonly<{ kind: "interrupted" }>;

/** The host owns one budget per Cliniko API user; adapters reserve before every request. */
export type ClinikoRequestBudget = Readonly<{
  /** Current admission check for a composed operation; not a reservation. Every request still claims normally. */
  checkHeadroom?(requests: number): ClinikoBudgetDenial | null | Promise<ClinikoBudgetDenial | null>;
  /** A short allocation scope. Denial cannot invoke the task; interruption may
   * follow a send and must never be treated as a definitively unsent operation. */
  withReservation?<T>(requests: number, signal: AbortSignal, task: () => Promise<T>): Promise<ClinikoReservedRun<T>>;
  claim(): ClinikoBudgetDenial | null | Promise<ClinikoBudgetDenial | null>;
  observe429(resetHeader: string | null): ClinikoRateLimit | Promise<ClinikoRateLimit>;
}>;

export function isClinikoRequestBudget(value: unknown): value is ClinikoRequestBudget {
  return typeof value === "object" && value !== null &&
    typeof (value as ClinikoRequestBudget).claim === "function" &&
    typeof (value as ClinikoRequestBudget).observe429 === "function";
}

function normalizedLimit(value: unknown): ClinikoRateLimit | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as Partial<ClinikoRateLimit>;
  if (result.kind !== "rateLimited") return null;
  if (result.retryAfterMs !== undefined && (!Number.isSafeInteger(result.retryAfterMs) || result.retryAfterMs < 1 || result.retryAfterMs > 8_640_000_000)) return null;
  const delay = result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs };
  if (result.resetAt === undefined) return { kind: "rateLimited", ...delay };
  return typeof result.resetAt === "string" && Number.isFinite(Date.parse(result.resetAt))
    ? { kind: "rateLimited", resetAt: result.resetAt, ...delay } : null;
}

function normalizedDenial(value: unknown): ClinikoBudgetDenial | null {
  if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "unavailable") {
    return { kind: "unavailable" };
  }
  return normalizedLimit(value);
}

/** A failed or malformed host reservation cannot authorize a provider request. */
export async function claimClinikoBudget(budget: ClinikoRequestBudget): Promise<ClinikoBudgetDenial | null> {
  try {
    const result: unknown = await budget.claim();
    if (result === null) return null;
    const denied = normalizedDenial(result);
    if (denied) return denied;
  } catch { /* Budget failure closes the request path. */ }
  return { kind: "unavailable" };
}

/** Refuse a known-insufficient multi-step operation before any native mutation.
 * Concurrent consumers may still change capacity; this never replaces claims. */
export async function checkClinikoHeadroom(budget: ClinikoRequestBudget, requests: number): Promise<ClinikoBudgetDenial | null> {
  if (!Number.isSafeInteger(requests) || requests < 1 || requests > 200 || typeof budget.checkHeadroom !== "function") return { kind: "unavailable" };
  try {
    const value: unknown = await budget.checkHeadroom(requests);
    return value === null ? null : normalizedDenial(value) ?? { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}

/** A budget port cannot invent a successful callback result or invoke it twice. */
export async function withClinikoReservation<T>(budget: ClinikoRequestBudget, requests: number, signal: AbortSignal, task: () => Promise<T>): Promise<ClinikoReservedRun<T>> {
  const unavailable = (): ClinikoReservedRun<T> => ({ kind: "denied", denial: { kind: "unavailable" } });
  if (!Number.isSafeInteger(requests) || requests < 1 || requests > 200 || !(signal instanceof AbortSignal) || signal.aborted ||
      typeof task !== "function" || typeof budget.withReservation !== "function") return unavailable();
  let open = true, started = false, invalid = false, captured: { value: T } | undefined;
  try {
    const result = await budget.withReservation(requests, signal, async () => {
      if (!open || started || signal.aborted) { invalid = true; throw new Error("invalid allocation callback"); }
      started = true; const value = await task(); captured = { value }; return value;
    });
    if (result?.kind === "completed" && captured && !invalid && !signal.aborted) return { kind: "completed", value: captured.value };
    if (started) return { kind: "interrupted" };
    return result?.kind === "denied" ? { kind: "denied", denial: normalizedDenial(result.denial) ?? { kind: "unavailable" } } : unavailable();
  } catch { return started ? { kind: "interrupted" } : unavailable(); }
  finally { open = false; }
}

export async function observeCliniko429(budget: ClinikoRequestBudget,
                                  resetHeader: string | null): Promise<ClinikoRateLimit> {
  try {
    const result: unknown = await budget.observe429(resetHeader);
    const limited = normalizedLimit(result);
    if (limited) return limited;
  } catch { /* Budget failure closes the request path. */ }
  return { kind: "rateLimited" };
}

/** A process-local budget shared by readers using the same Cliniko API user. */
export class ClinikoReadBudget implements ClinikoRequestBudget {
  private readonly sentAt: number[] = [];
  private cooldownUntil = 0;
  private readonly maxPerMinute: number;
  private readonly clock: () => number;
  private readonly holds = new Map<string, BudgetHold>();

  constructor(maxPerMinute = 200, clock: () => number = Date.now) {
    if (!Number.isSafeInteger(maxPerMinute) || maxPerMinute < 1 || maxPerMinute > 200 || typeof clock !== "function") {
      throw new Error("invalid Cliniko read budget");
    }
    this.maxPerMinute = maxPerMinute;
    this.clock = clock;
  }

  private state(): BudgetState {
    const now = this.clock();
    while (this.sentAt.length && this.sentAt[0]! <= now - 60_000) this.sentAt.shift();
    for (const [id, hold] of this.holds) if (hold.expiresAt <= now) this.holds.delete(id);
    return { now, limit: this.maxPerMinute, cooldown: this.cooldownUntil, recent: this.sentAt, holds: [...this.holds.values()] };
  }
  /** Observe capacity, including other owners' held requests. */
  checkHeadroom(requests: number): ClinikoBudgetDenial | null {
    try {
      const context = budgetReservationContext(this);
      return context && !context.valid ? { kind: "unavailable" } : budgetCapacity(this.state(), requests, context?.id);
    } catch { return { kind: "unavailable" }; }
  }
  /** Reserve before sending. Synchronous reservation keeps concurrent callers under one process budget. */
  claim(): ClinikoBudgetDenial | null {
    try {
      const context = budgetReservationContext(this);
      if (context && !context.valid) return { kind: "unavailable" };
      const state = this.state(), denial = budgetCapacity(state, 1, context?.id);
      if (denial) return claimDenial(denial);
      if (context) { const hold = this.holds.get(context.id)!; this.holds.set(context.id, { ...hold, remaining: hold.remaining - 1 }); }
      this.sentAt.push(state.now); return null;
    } catch { return { kind: "unavailable" }; }
  }

  async withReservation<T>(requests: number, signal: AbortSignal, task: () => Promise<T>): Promise<ClinikoReservedRun<T>> {
    if (!(signal instanceof AbortSignal) || signal.aborted || typeof task !== "function" || budgetReservationContext(this)) return { kind: "denied", denial: { kind: "unavailable" } };
    try {
      const state = this.state(), denial = budgetCapacity(state, requests);
      if (denial) return { kind: "denied", denial };
      const id = randomUUID(); this.holds.set(id, { id, remaining: requests, expiresAt: state.now + reservationLifetimeMs });
      return await runBudgetReservation(this, id, signal, task, async () => { this.holds.delete(id); });
    } catch { return { kind: "denied", denial: { kind: "unavailable" } }; }
  }

  /** A provider 429 fences all readers that share this budget, even with a missing reset header. */
  observe429(resetHeader: string | null): ClinikoRateLimit {
    let now: number;
    try { now = this.clock(); }
    catch { return { kind: "rateLimited" }; }
    if (!Number.isSafeInteger(now) || now < 0) return { kind: "rateLimited" };
    const seconds = resetHeader && /^[0-9]+$/.test(resetHeader) ? Number(resetHeader) : NaN;
    const providerReset = Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000
      ? seconds * 1000 : NaN;
    const until = Number.isSafeInteger(providerReset) && providerReset > now ? providerReset : now + 60_000;
    this.cooldownUntil = Math.max(this.cooldownUntil, until);
    return { kind: "rateLimited", resetAt: new Date(this.cooldownUntil).toISOString() };
  }
}
