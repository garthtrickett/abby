import { fileURLToPath } from "node:url";
import { voiceAlertInboxFromEnvironment } from "./serve-voice-operational-alert-receiver.ts";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw new Error("invalid arguments");
    process.stdout.write(`${JSON.stringify(await voiceAlertInboxFromEnvironment(process.env).snapshot())}\n`);
  } catch { process.stderr.write("operational alert inbox unavailable\n"); process.exitCode = 1; }
}
