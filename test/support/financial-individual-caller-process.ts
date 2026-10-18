/** Fully emitted caller plus outliving provider actor and independent money worker. */
import { financialIndividualCaller } from "./financial-individual-caller.ts";
let started = false;
process.on("message", async (raw: unknown) => {
  if (started || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as { kind?: unknown; passes?: unknown; outcome?: unknown; perCall?: unknown };
  if (input.kind !== "start" || typeof input.passes !== "boolean" || (!["paid", "closedUnpaid"].includes(String(input.outcome)) || Object.keys(input).sort().join(",") !== (input.perCall === true ? "kind,outcome,passes,perCall" : "kind,outcome,passes") || input.perCall !== undefined && input.perCall !== true || input.passes !== false)) return;
  started = true;
  try {
    if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.DATABASE_URL !== "intentionally-not-a-database-url") throw new Error("isolated caller chain required");
    await financialIndividualCaller(input.outcome as "paid" | "closedUnpaid", stage => process.send?.({ kind: "stage", stage }), undefined, undefined, input.perCall === true);
    process.send?.({ kind: "result", passed: true, file: 0, line: 0 });
  } catch (error) {
    // Preserve only a fixed module number and bounded source line. Assertions,
    // provider responses, identifiers, paths and queries cannot cross the IPC.
    const files = ["financial-class-caller-chain.js", "financial-individual-caller.js", "financial-consumer-peer.js"];
    const stack = error instanceof Error ? error.stack ?? "" : "";
    const file = files.findIndex(name => stack.includes(name + ":"));
    const found = file >= 0 ? Number(new RegExp(files[file]!.replaceAll(".", "\\.") + ":(\\d+):").exec(stack)?.[1]) : 0;
    const line = Number.isSafeInteger(found) && found >= 0 && found <= 4096 ? found : 0;
    process.send?.({ kind: "result", passed: false, file: file + 1, line }); process.exitCode = 1;
  }
  finally { if (process.connected) process.disconnect(); }
});
