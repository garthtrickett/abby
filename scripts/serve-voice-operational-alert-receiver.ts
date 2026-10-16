import { fileURLToPath } from "node:url";
import { parseAggregateAlertThresholds } from "../src/standalone/operational-alert.ts";
import { VoiceOperationalAlertInbox } from "../src/standalone/voice-operational-alert-inbox.ts";
import { startVoiceOperationalAlertReceiver } from "../src/standalone/voice-operational-alert-receiver.ts";

export function voiceAlertInboxFromEnvironment(env: NodeJS.ProcessEnv) {
  const required = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error("operational alert inbox unavailable"); return value; };
  return new VoiceOperationalAlertInbox({ scope: { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID"), locationId: required("ABBY_LOCATION_ID") },
    tokenHex: required("ABBY_VOICE_ALERT_TOKEN_HEX"), thresholds: parseAggregateAlertThresholds(required("ABBY_VOICE_OPS_THRESHOLDS_JSON")),
    directory: required("ABBY_VOICE_ALERT_INBOX_DIRECTORY") });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw new Error("invalid arguments");
    const raw = process.env.ABBY_VOICE_ALERT_RECEIVER_PORT ?? "9041";
    if (!/^(?:0|[1-9][0-9]{0,4})$/.test(raw)) throw new Error("invalid port");
    const receiver = await startVoiceOperationalAlertReceiver(voiceAlertInboxFromEnvironment(process.env), Number(raw));
    process.stdout.write(`${JSON.stringify({ port: receiver.port })}\n`);
    let closing = false;
    const close = () => { if (closing) return; closing = true; void receiver.close().catch(() => { process.stderr.write("operational alert receiver unavailable\n"); process.exitCode = 1; }); };
    process.once("SIGTERM", close); process.once("SIGINT", close);
  } catch { process.stderr.write("operational alert receiver unavailable\n"); process.exitCode = 1; }
}
