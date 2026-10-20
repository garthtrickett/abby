import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { connectPostgres } from "../../src/storage/connect.ts";

const apiKey = process.env.ABBY_SYNTHETIC_BUDGET_KEY;
if (!apiKey?.startsWith("synthetic-") || !process.env.DATABASE_URL || !process.send) throw new Error("synthetic allocation worker configuration required");
const db = connectPostgres(process.env.DATABASE_URL), lifetime = new AbortController();
let finish!: () => void;
const gate = new Promise<void>(resolve => { finish = resolve; });
process.on("message", m => { if (m && typeof m === "object" && "kind" in m && m.kind === "finish") finish(); });
process.on("disconnect", () => { lifetime.abort(); finish(); });
try {
  const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 4 });
  const result = await budget.withReservation(4, lifetime.signal, async () => {
    process.send?.({ kind: "held" }); await gate;
    const claims = [await budget.claim(), await budget.claim()];
    process.send?.({ kind: "ownerClaims", accepted: claims.filter(x => x === null).length });
    return "done";
  });
  process.send?.({ kind: "done", outcome: result.kind });
} finally { await db.destroy(); process.disconnect?.(); }
