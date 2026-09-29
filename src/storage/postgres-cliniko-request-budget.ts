import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { ClinikoBudgetDenial, ClinikoRateLimit, ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type Database from "./generated/Database.ts";
import type { ClinikoRequestBudgetsBudgetRef } from "./generated/public/ClinikoRequestBudgets.ts";

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

  constructor(db: Kysely<Database>, config: Readonly<{
    apiKey: string;
    /** Supply the same non-patient reference when multiple keys belong to one Cliniko user. */
    sharedUserRef?: string;
    maxPerMinute?: number;
  }>) {
    if (!config.apiKey?.trim() || config.apiKey.length > 2_000 ||
        (config.sharedUserRef !== undefined && (!config.sharedUserRef.trim() || config.sharedUserRef.length > 256)) ||
        !Number.isSafeInteger(config.maxPerMinute ?? 180) || (config.maxPerMinute ?? 180) < 1 ||
        (config.maxPerMinute ?? 180) > 200) throw new RangeError("invalid Cliniko budget configuration");
    this.db = db;
    this.budgetRef = createHash("sha256")
      .update(`abby-cliniko-budget-v1\0${config.sharedUserRef ?? config.apiKey}`)
      .digest("hex") as ClinikoRequestBudgetsBudgetRef;
    this.maxPerMinute = config.maxPerMinute ?? 180;
  }

  private async locked<T>(run: (trx: Kysely<Database>, now: number,
    row: Readonly<{ sent_at_ms: unknown; cooldown_until_ms: string; max_per_minute: number }>) => Promise<T>): Promise<T> {
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
      return run(trx, millis(clock.rows[0].now_ms), row);
    });
  }

  async claim(): Promise<ClinikoBudgetDenial | null> {
    try {
      return await this.locked(async (trx, now, row) => {
        const cooldownUntil = millis(row.cooldown_until_ms);
        if (now < cooldownUntil) return { kind: "rateLimited", resetAt: new Date(cooldownUntil).toISOString() };
        const recent = sentTimes(row.sent_at_ms).filter(at => at > now - minuteMs);
        if (recent.length >= this.maxPerMinute) {
          return { kind: "rateLimited", resetAt: new Date(recent[0]! + minuteMs).toISOString() };
        }
        recent.push(now);
        await trx.updateTable("cliniko_request_budgets")
          .set({ sent_at_ms: JSON.stringify(recent) })
          .where("budget_ref", "=", this.budgetRef).execute();
        return null;
      });
    } catch { return { kind: "unavailable" }; }
  }

  async observe429(resetHeader: string | null): Promise<ClinikoRateLimit> {
    try {
      return await this.locked(async (trx, now, row) => {
        const seconds = resetHeader && /^[0-9]+$/.test(resetHeader) ? Number(resetHeader) : NaN;
        const providerReset = Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000
          ? seconds * 1_000 : NaN;
        const until = Math.max(millis(row.cooldown_until_ms),
          Number.isSafeInteger(providerReset) && providerReset > now ? providerReset : now + minuteMs);
        await trx.updateTable("cliniko_request_budgets")
          .set({ cooldown_until_ms: String(until) })
          .where("budget_ref", "=", this.budgetRef).execute();
        return { kind: "rateLimited", resetAt: new Date(until).toISOString() };
      });
    } catch { return { kind: "rateLimited" }; }
  }
}
