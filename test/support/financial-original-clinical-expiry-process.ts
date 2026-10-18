import { financialExpiryFailureObservation } from "./financial-expiry-observation.ts";
import { financialOriginalClinicalExpiry } from "./financial-original-clinical-expiry.ts";
import type { OriginalClinicalKind } from "./financial-original-clinical-expiry.ts";
let started = false;
process.on("message", async (raw: unknown) => {
  if (started || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const input = raw as { kind?: unknown; scenario?: unknown };
  if (Object.keys(raw).sort().join(",") !== "kind,scenario" || input.kind !== "start" ||
      !["individual", "ordinaryClass", "passClass", "reviewTerms"].includes(String(input.scenario))) return;
  started = true;
  try {
    if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || process.env.DATABASE_URL !== "intentionally-not-a-database-url") throw new Error("isolated caller expiry required");
    await financialOriginalClinicalExpiry(input.scenario as OriginalClinicalKind, stage => process.send?.({ kind: "stage", stage }));
    process.send?.({ kind: "result", passed: true, file: 0, line: 0 });
  } catch (error) {
    // Only a fixed module number and bounded source line may cross this seam.
    // Error messages, values, queries, paths and provider payloads stay private.
    const files = ["financial-original-clinical-expiry.js", "financial-individual-caller.js", "financial-class-voice-journey.js"];
    const stack = error instanceof Error ? error.stack ?? "" : "";
    const file = files.findIndex(name => stack.includes(name + ":"));
    const found = file >= 0 ? Number(new RegExp(files[file]!.replaceAll(".", "\\.") + ":(\\d+):").exec(stack)?.[1]) : 0;
    const line = Number.isSafeInteger(found) && found >= 0 && found <= 4096 ? found : 0;
    const observation = financialExpiryFailureObservation(error);
    process.send?.({ kind: "result", passed: false, file: file + 1, line, ...(observation ? { observation } : {}) }); process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
});
