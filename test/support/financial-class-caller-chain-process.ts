/** Fully emitted caller plus outliving provider actor and independent money worker. */
import { financialClassUnpaidChain } from "./financial-class-unpaid-chain.ts";
import { financialClassCallerChain } from "./financial-class-caller-chain.ts";
let started = false;
process.on("message", async (raw: unknown) => {
  if (started || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as { kind?: unknown; passes?: unknown; outcome?: unknown };
  if (input.kind !== "start" || typeof input.passes !== "boolean" || (input.outcome === undefined ? Object.keys(input).sort().join(",") !== "kind,passes" : input.outcome !== "closedUnpaid" || Object.keys(input).sort().join(",") !== "kind,outcome,passes")) return;
  started = true;
  try {
    if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.DATABASE_URL !== "intentionally-not-a-database-url") throw new Error("isolated caller chain required");
    await (input.outcome === "closedUnpaid" ? financialClassUnpaidChain : financialClassCallerChain)(input.passes, stage => process.send?.({ kind: "stage", stage }));
    process.send?.({ kind: "result", passed: true });
  } catch { process.send?.({ kind: "result", passed: false }); process.exitCode = 1; }
  finally { if (process.connected) process.disconnect(); }
});
