/** Fully emitted caller plus outliving provider actor and independent money worker. */
import { financialIndividualCaller } from "./financial-individual-caller.ts";
let started = false;
process.on("message", async (raw: unknown) => {
  if (started || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as { kind?: unknown; passes?: unknown; outcome?: unknown };
  if (input.kind !== "start" || typeof input.passes !== "boolean" || (!["paid", "closedUnpaid"].includes(String(input.outcome)) || Object.keys(input).sort().join(",") !== "kind,outcome,passes" || input.passes !== false)) return;
  started = true;
  try {
    if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.DATABASE_URL !== "intentionally-not-a-database-url") throw new Error("isolated caller chain required");
    await financialIndividualCaller(input.outcome as "paid" | "closedUnpaid", stage => process.send?.({ kind: "stage", stage }));
    process.send?.({ kind: "result", passed: true });
  } catch { process.send?.({ kind: "result", passed: false }); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
});
