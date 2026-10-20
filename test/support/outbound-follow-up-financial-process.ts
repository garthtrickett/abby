import { outboundFollowUpFinancialCaller } from "./outbound-follow-up-financial-caller.ts";
let started = false;
process.on("message", async (raw: unknown) => {
  if (started || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as { kind?: unknown; outcome?: unknown };
  if (Object.keys(input).sort().join(",") !== "kind,outcome" || input.kind !== "start" ||
      input.outcome !== "paid" && input.outcome !== "closedUnpaid") return;
  started = true;
  try {
    if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.DATABASE_URL !== "intentionally-not-a-database-url")
      throw Error("isolated outgoing financial caller required");
    await outboundFollowUpFinancialCaller(input.outcome as "paid" | "closedUnpaid", stage => process.send?.({ kind: "stage", stage }));
    process.send?.({ kind: "result", passed: true, file: 0, line: 0 });
  } catch (error) {
    // Report only a fixed module and bounded line, never private assertions,
    // native records, recipient addresses or provider responses.
    const files = ["outbound-follow-up-financial-caller.js", "outbound-follow-up-financial.js", "financial-caller-context.js",
      "financial-class-caller-chain.js", "financial-class-unpaid-chain.js", "financial-consumer-peer.js"];
    const stack = error instanceof Error ? error.stack ?? "" : "";
    const file = files.findIndex(name => stack.includes(name + ":"));
    const found = file >= 0 ? Number(new RegExp(files[file]!.replaceAll(".", "\\.") + ":(\\d+):").exec(stack)?.[1]) : 0;
    const line = Number.isSafeInteger(found) && found >= 0 && found <= 4096 ? found : 0;
    process.send?.({ kind: "result", passed: false, file: file + 1, line }); process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
});
