/** Separately emitted serving/driver process. All provider ports are synthetic;
 * only fixed success/failure IPC leaves this process, never financial context. */
import { financialClassVoiceJourney } from "./financial-class-voice-journey.ts";
let started = false;
process.on("message", async (raw: unknown) => {
  if (started || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const value = raw as { kind?: unknown; passes?: unknown };
  if (value.kind !== "start" || typeof value.passes !== "boolean" || Object.keys(value).sort().join(",") !== "kind,passes") return;
  started = true;
  try {
    if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !process.env.DATABASE_URL?.includes("/abby_test")) throw new Error("isolated financial serving fixture required");
    await financialClassVoiceJourney(value.passes);
    process.send?.({ kind: "result", passed: true });
  } catch {
    process.send?.({ kind: "result", passed: false });
    process.exitCode = 1;
  } finally { if (process.connected) process.disconnect(); }
});
