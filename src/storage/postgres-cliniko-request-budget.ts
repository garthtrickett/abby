import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { ClinikoBudgetDenial, ClinikoBudgetOperationalEvent, ClinikoRateLimit,
  ClinikoRequestBudget, ClinikoReservedRun } from "../cliniko/read-budget.ts";
import { budgetReservationContext, runBudgetReservation } from "../cliniko/budget-reservation-context.ts";
import { budgetCapacity, claimDenial, reservationLifetimeMs, validateBudgetState } from "../cliniko/request-budget-state.ts";
import type { BudgetState } from "../cliniko/request-budget-state.ts";
import type Database from "./generated/Database.ts";
import type { ClinikoRequestBudgetsBudgetRef } from "./generated/public/ClinikoRequestBudgets.ts";
import type { ClinikoRequestReservationsLeaseRef } from "./generated/public/ClinikoRequestReservations.ts";

const minuteMs = 60_000;

function millis(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid Cliniko budget clock");
  return parsed;
}

function sentTimes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 200 ||
      value.some(item => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error("invalid Cliniko budget state");
  }
  const times = value as number[];
  if (times.some((item, index) => index > 0 && item < times[index - 1]!)) {
    throw new Error("unordered Cliniko budget state");
  }
  return times;
}

/** PostgreSQL coordinates all Abby processes using one API user without persisting the credential. */
export class PostgresClinikoRequestBudget implements ClinikoRequestBudget {
  private readonly db: Kysely<Database>;
  private readonly budgetRef: ClinikoRequestBudgetsBudgetRef;
  private readonly maxPerMinute: number;
  private readonly credentialFingerprint: string;
  private readonly onEvent: ((event: ClinikoBudgetOperationalEvent) => void | Promise<void>) | undefined;

  constructor(db: Kysely<Database>, config: Readonly<{
    apiKey: string;
    /** Supply the same non-patient reference when multiple keys belong to one Cliniko user. */
    sharedUserRef?: string;
    maxPerMinute?: number;
    /** Fixed-code diagnostic only; callback failure never changes a provider decision. */
    onEvent?: (event: ClinikoBudgetOperationalEvent) => void | Promise<void>;
  }>) {
    if (!config.apiKey?.trim() || config.apiKey.length > 2_000 ||
        (config.sharedUserRef !== undefined && (!config.sharedUserRef.trim() || config.sharedUserRef.length > 256)) ||
        !Number.isSafeInteger(config.maxPerMinute ?? 180) || (config.maxPerMinute ?? 180) < 1 ||
        (config.maxPerMinute ?? 180) > 200 ||
        (config.onEvent !== undefined && typeof config.onEvent !== "function")) {
      throw new RangeError("invalid Cliniko budget configuration");
    }
    this.db = db;
    this.credentialFingerprint = clinikoCredentialFingerprint(config.apiKey);
    this.budgetRef = createHash("sha256")
      .update(`abby-cliniko-budget-v1\0${config.sharedUserRef ?? config.apiKey}`)
      .digest("hex") as ClinikoRequestBudgetsBudgetRef;
    this.maxPerMinute = config.maxPerMinute ?? 180;
    this.onEvent = config.onEvent;
  }

  private report(event: ClinikoBudgetOperationalEvent): void {
    try { void Promise.resolve(this.onEvent?.(event)).catch(() => undefined); }
    catch { /* Diagnostics cannot authorize or suppress a Cliniko request. */ }
  }

  /** Standalone listeners must share their own database connection with this budget. */
  matchesDatabase(db: Kysely<Database>): boolean { return this.db === db; }

  matchesCredentialFingerprint(fingerprint: string): boolean { return this.credentialFingerprint === fingerprint; }

  private async locked<T>(run: (trx: Kysely<Database>, state: BudgetState) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async trx => {
      await trx.insertInto("cliniko_request_budgets")
        .values({ budget_ref: this.budgetRef, max_per_minute: this.maxPerMinute })
        .onConflict(conflict => conflict.column("budget_ref").doNothing()).execute();
      const row = await trx.selectFrom("cliniko_request_budgets")
        .select(["sent_at_ms", "cooldown_until_ms", "max_per_minute"])
        .where("budget_ref", "=", this.budgetRef).forUpdate().executeTakeFirstOrThrow();
      if (row.max_per_minute !== this.maxPerMinute) throw new Error("conflicting Cliniko budget limit");
      const clock = await sql<{ now_ms: string }>`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now_ms`
        .execute(trx);
      if (!clock.rows[0]) throw new Error("Cliniko budget clock unavailable");
      const now = millis(clock.rows[0].now_ms);
      await trx.deleteFrom("cliniko_request_reservations").where("budget_ref", "=", this.budgetRef)
        .where("expires_at_ms", "<=", String(now)).execute();
      const held = await trx.selectFrom("cliniko_request_reservations").select(["lease_ref", "remaining", "expires_at_ms"])
        .where("budget_ref", "=", this.budgetRef).execute();
      const state: BudgetState = { now, limit: this.maxPerMinute, cooldown: millis(row.cooldown_until_ms),
        recent: sentTimes(row.sent_at_ms).filter(at => at > now - minuteMs),
        holds: held.map(h => ({ id: h.lease_ref, remaining: h.remaining, expiresAt: millis(h.expires_at_ms) })) };
      validateBudgetState(state); return run(trx, state);
    });
  }

  /** Check current shared account headroom without consuming it. Subsequent
   * requests still use the same locked claim and provider-cooldown path. */
  async checkHeadroom(requests: number): Promise<ClinikoBudgetDenial | null> {
    if (!Number.isSafeInteger(requests) || requests < 1 || requests > this.maxPerMinute) return { kind: "unavailable" };
    try {
      return await this.locked<ClinikoBudgetDenial | null>(async (_trx, state) => {
        const context = budgetReservationContext(this.budgetRef);
        return context && !context.valid ? { kind: "unavailable" } : budgetCapacity(state, requests, context?.id);
      });
    } catch { return { kind: "unavailable" }; }
  }

  async claim(): Promise<ClinikoBudgetDenial | null> {
    try {
      const result = await this.locked<ClinikoBudgetDenial | null>(async (trx, state) => {
        const context = budgetReservationContext(this.budgetRef);
        if (context && !context.valid) return { kind: "unavailable" };
        const denied = budgetCapacity(state, 1, context?.id); if (denied) return claimDenial(denied);
        if (context) {
          const hold = state.holds.find(h => h.id === context.id)!;
          await trx.updateTable("cliniko_request_reservations").set({ remaining: hold.remaining - 1 })
            .where("budget_ref", "=", this.budgetRef).where("lease_ref", "=", context.id as ClinikoRequestReservationsLeaseRef).executeTakeFirstOrThrow();
        }
        await trx.updateTable("cliniko_request_budgets")
          .set({ sent_at_ms: JSON.stringify([...state.recent, state.now]) })
          .where("budget_ref", "=", this.budgetRef).execute();
        return null;
      });
      if (budgetReservationContext(this.budgetRef)?.valid === false) { this.report("claimUnavailable"); return { kind: "unavailable" }; }
      if (result?.kind === "rateLimited") this.report("claimRateLimited");
      return result;
    } catch {
      this.report("claimUnavailable");
      return { kind: "unavailable" };
    }
  }

  async withReservation<T>(requests: number, signal: AbortSignal, task: () => Promise<T>): Promise<ClinikoReservedRun<T>> {
    if (!Number.isSafeInteger(requests) || requests < 1 || requests > this.maxPerMinute || !(signal instanceof AbortSignal) ||
        signal.aborted || typeof task !== "function" || budgetReservationContext(this.budgetRef)) return { kind: "denied", denial: { kind: "unavailable" } };
    try {
      const held = await this.locked<{ id: string } | { denial: ClinikoBudgetDenial }>(async (trx, state) => {
        if (signal.aborted) return { denial: { kind: "unavailable" } };
        const denial = budgetCapacity(state, requests); if (denial) return { denial };
        const id = randomUUID();
        await trx.insertInto("cliniko_request_reservations").values({ lease_ref: id as ClinikoRequestReservationsLeaseRef,
          budget_ref: this.budgetRef, remaining: requests, expires_at_ms: String(state.now + reservationLifetimeMs) }).execute();
        return { id };
      });
      if ("denial" in held) return { kind: "denied", denial: held.denial };
      return await runBudgetReservation(this.budgetRef, held.id, signal, task, async () => {
        await this.locked(async trx => { await trx.deleteFrom("cliniko_request_reservations").where("budget_ref", "=", this.budgetRef)
          .where("lease_ref", "=", held.id as ClinikoRequestReservationsLeaseRef).execute(); });
      });
    } catch { return { kind: "denied", denial: { kind: "unavailable" } }; }
  }

  async observe429(resetHeader: string | null): Promise<ClinikoRateLimit> {
    this.report("provider429");
    try {
      return await this.locked(async (trx, state) => {
        const seconds = resetHeader && /^[0-9]+$/.test(resetHeader) ? Number(resetHeader) : NaN;
        const providerReset = Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000
          ? seconds * 1_000 : NaN;
        const until = Math.max(state.cooldown,
          Number.isSafeInteger(providerReset) && providerReset > state.now ? providerReset : state.now + minuteMs);
        await trx.updateTable("cliniko_request_budgets")
          .set({ cooldown_until_ms: String(until) })
          .where("budget_ref", "=", this.budgetRef).execute();
        return { kind: "rateLimited", resetAt: new Date(until).toISOString() };
      });
    } catch { return { kind: "rateLimited" }; }
  }
}
