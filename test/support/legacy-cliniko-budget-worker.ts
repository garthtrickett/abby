import { createHash } from "node:crypto";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import type { ClinikoRequestBudgetsBudgetRef } from "../../src/storage/generated/public/ClinikoRequestBudgets.ts";

const apiKey = process.env.ABBY_SYNTHETIC_BUDGET_KEY;
if (!apiKey?.startsWith("synthetic-") || !process.env.DATABASE_URL || !process.send) throw new Error("synthetic legacy budget configuration required");
const db = connectPostgres(process.env.DATABASE_URL), budgetRef = createHash("sha256").update(`abby-cliniko-budget-v1\0${apiKey}`).digest("hex") as ClinikoRequestBudgetsBudgetRef;
try {
  // Independent pre-allocation client: the old algorithm locks the account and
  // checks only sent timestamps/cooldown. It knows nothing about held capacity.
  const accepted = await db.transaction().execute(async trx => {
    const row = await trx.selectFrom("cliniko_request_budgets").selectAll().where("budget_ref", "=", budgetRef).forUpdate().executeTakeFirstOrThrow();
    const clock = await sql<{ now: string }>`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as now`.execute(trx);
    const now = Number(clock.rows[0]!.now), recent = (row.sent_at_ms as number[]).filter(at => at > now - 60_000);
    if (now < Number(row.cooldown_until_ms) || recent.length >= row.max_per_minute) return false;
    await trx.updateTable("cliniko_request_budgets").set({ sent_at_ms: JSON.stringify([...recent, now]) }).where("budget_ref", "=", budgetRef).execute();
    return true;
  }).catch(() => false);
  process.send?.({ kind: "legacyClaim", accepted });
} finally { await db.destroy(); process.disconnect?.(); }
