/** Fully emitted caller plus outliving provider actor and independent money worker. */
import { financialIndividualCaller } from "./financial-individual-caller.ts";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
let started = false;
process.on("message", async (raw: unknown) => {
  if (started || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as { kind?: unknown; passes?: unknown; outcome?: unknown; perCall?: unknown; offerPrefix?: unknown };
  const expectedKeys = ["kind", "outcome", "passes", ...(input.perCall === true ? ["perCall"] : []), ...(input.offerPrefix !== undefined ? ["offerPrefix"] : [])].sort().join(",");
  if (input.kind !== "start" || typeof input.passes !== "boolean" || (!["paid", "closedUnpaid"].includes(String(input.outcome)) ||
      Object.keys(input).sort().join(",") !== expectedKeys || input.perCall !== undefined && input.perCall !== true || input.passes !== false ||
      input.offerPrefix !== undefined && (input.perCall !== true || !["-", "_"].includes(String(input.offerPrefix))))) return;
  started = true;
  const originalRandomBytes = crypto.randomBytes;
  try {
    if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.DATABASE_URL !== "intentionally-not-a-database-url") throw new Error("isolated caller chain required");
    if (input.offerPrefix !== undefined) {
      // Only this isolated synthetic child: exercise valid issuer values rather
      // than depending on a random six-bit prefix. Proofs, salts, other lengths
      // and callback draws retain the original implementation.
      const draw = originalRandomBytes.bind(crypto), prefix = input.offerPrefix;
      crypto.randomBytes = ((size: number, callback?: (error: Error | null, bytes: Buffer) => void) => {
        if (callback) return draw(size, callback);
        const bytes = draw(size);
        if (size === 24) bytes[0] = (bytes[0]! & 3) | (prefix === "-" ? 248 : 252);
        return bytes;
      }) as typeof crypto.randomBytes;
      syncBuiltinESMExports();
    }
    await financialIndividualCaller(input.outcome as "paid" | "closedUnpaid", stage => process.send?.({ kind: "stage", stage }), undefined, undefined, input.perCall === true,
      input.offerPrefix as "-" | "_" | undefined);
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
  finally { crypto.randomBytes = originalRandomBytes; syncBuiltinESMExports(); if (process.connected) process.disconnect(); }
});
