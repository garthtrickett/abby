import { fileURLToPath } from "node:url";
import { renderVoiceOpsSystemd } from "./render-voice-ops-systemd.mjs";

export function renderVoiceOpsAlertSystemd(argv) {
  return renderVoiceOpsSystemd(argv, "alert");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await renderVoiceOpsAlertSystemd(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("operational alert systemd units unavailable\n");
    process.exitCode = 1;
  }
}
