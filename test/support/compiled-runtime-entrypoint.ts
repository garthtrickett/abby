import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";

type RuntimeEntrypoint = "scripts/serve-cliniko-voice.ts" |
  "scripts/serve-voice-operational-alert-receiver.ts" | "scripts/read-voice-operational-alert-inbox.ts" |
  "scripts/monitor-cliniko-queue.ts" |
  "test/support/start-synthetic-queue-monitor.ts" |
  "scripts/set-voice-test-automation.ts" | "test/support/start-synthetic-voice-runner.ts" |
  "test/support/start-synthetic-clinical-runner.ts" |
  "test/support/start-synthetic-class-runner.ts" |
  "test/support/start-synthetic-resend-runner.ts" |
  "test/support/standalone-cancellation-worker.ts" | "test/support/standalone-rescheduling-worker.ts";

/** Resolve a separately compiled service or test worker without a source fallback. */
export function compiledRuntimeEntrypoint(entry: RuntimeEntrypoint): string {
  const target = new URL(`../../dist/runtime/${entry.replace(/\.ts$/, ".js")}`, import.meta.url);
  try { accessSync(target); }
  catch { throw new Error("process fixture requires npm run build:voice-tests"); }
  return fileURLToPath(target);
}
