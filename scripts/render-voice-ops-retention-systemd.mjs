import { fileURLToPath } from "node:url";
import { renderVoiceOpsSystemd } from "./render-voice-ops-systemd.mjs";

export function renderVoiceOpsRetentionSystemd(argv) {
  return renderVoiceOpsSystemd(argv, "retention");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = await renderVoiceOpsRetentionSystemd(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("operational retention systemd units unavailable\n");
    process.exitCode = 1;
  }
}
