import { fileURLToPath } from "node:url";
import { renderVoiceOpsSystemd } from "./render-voice-ops-systemd.mjs";

export const renderClinikoQueueMonitorSystemd = argv => renderVoiceOpsSystemd(argv, "queue");
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.stdout.write(`${JSON.stringify(await renderClinikoQueueMonitorSystemd(process.argv.slice(2)))}\n`); }
  catch { process.stderr.write("Cliniko queue monitor units unavailable\n"); process.exitCode = 1; }
}
