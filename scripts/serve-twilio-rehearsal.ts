import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRestrictedTwilioTarget } from "../src/testing/restricted-twilio-target.ts";
import type { RehearsalCallStatistics } from "../src/testing/restricted-twilio-target.ts";
import { DeepgramStreamingTranscription } from "../src/voice/deepgram-streaming-transcription.ts";
import { OpenAISpeechSynthesis } from "../src/voice/openai-speech-synthesis.ts";
import { PostgresActiveCallClaims } from "../src/storage/postgres-active-call-claims.ts";

async function main() {
  const [mode, reportPath] = process.argv.slice(2);
  if (mode !== "--serve" || !reportPath || process.argv.length !== 4 || process.env.ABBY_VOICE_TEST_MODE !== "1") {
    throw Error("Explicit isolated rehearsal arguments required");
  }
  const e = process.env, port = Number(e.ABBY_REHEARSAL_TARGET_PORT ?? "3120");
  if (!Number.isSafeInteger(port) || port < 0 || (port > 0 && port < 1024) || port > 65535 ||
      !/^[a-f0-9]{64}$/i.test(e.ABBY_TWILIO_BINDING_KEY_HEX ?? "") ||
      !e.ABBY_DEEPGRAM_API_KEY || !e.ABBY_OPENAI_API_KEY) throw Error("Invalid rehearsal configuration");
  const number = e.ABBY_TWILIO_TEST_NUMBER ?? "", runId = randomBytes(16).toString("hex");
  const destination = resolve(reportPath), temporary = join(dirname(destination), `.${runId}.tmp`);
  const endAt = Date.now() + 3_600_000;
  const bindingKey = Buffer.from(e.ABBY_TWILIO_BINDING_KEY_HEX!, "hex");
  let latest: RehearsalCallStatistics | undefined, phase = "prepared";
  const app = createRestrictedTwilioTarget({ testMode: true, number,
    caller: e.ABBY_TWILIO_TEST_CALLER_NUMBER ?? "", endAt,
    activeCallClaims: new PostgresActiveCallClaims(e.DATABASE_URL ?? "", bindingKey),
    ...(e.ABBY_REHEARSAL_FALLBACK_CALLBACK_URL ? { fallbackCallback: e.ABBY_REHEARSAL_FALLBACK_CALLBACK_URL } : {}),
    ingress: { accountSid: e.ABBY_TWILIO_ACCOUNT_SID ?? "", authToken: e.ABBY_TWILIO_AUTH_TOKEN ?? "",
      publicWebhookUrl: e.ABBY_TWILIO_PUBLIC_WEBHOOK_URL ?? "", publicStreamUrl: e.ABBY_TWILIO_PUBLIC_STREAM_URL ?? "",
      bindingKey, fallbackNumbers: { [number]: e.ABBY_TWILIO_FALLBACK_NUMBER ?? "" } },
  }, {
    transcription: sessionId => new DeepgramStreamingTranscription({ apiKey: e.ABBY_DEEPGRAM_API_KEY!, sessionId }),
    synthesis: new OpenAISpeechSynthesis({ apiKey: e.ABBY_OPENAI_API_KEY! }),
  }, statistics => { latest = statistics; save(); });
  function save() {
    const address = app.server.address();
    writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), phase, runId,
      port: address && typeof address === "object" ? address.port : null,
      ...app.state(), latest: latest ?? null, clinicalAutomationEnabled: false,
      audioOrTranscriptPersisted: false, speechQualificationPassed: false }) + "\n", { mode: 0o600 });
    renameSync(temporary, destination);
  }
  // A new report path prevents a restart from silently reusing an earlier cohort.
  closeSync(openSync(destination, "wx", 0o600)); save();
  try {
    app.server.listen(port, "127.0.0.1"); await once(app.server, "listening");
    phase = "listening"; save();
  } catch (failure) {
    await app.stop().catch(() => {}); throw failure;
  }
  let ending = false;
  const stop = async () => {
    if (ending) return;
    ending = true; await app.stop(); phase = "stopped"; save();
  };
  const finish = () => { void stop().catch(() => { process.exitCode = 1;
    console.error("Restricted rehearsal shutdown report unavailable."); }); };
  process.once("SIGTERM", finish); process.once("SIGINT", finish);
  setTimeout(finish, Math.max(1, endAt - Date.now())).unref();
  console.log("Restricted public rehearsal target listening; one caller, six sessions, one-hour window.");
}
main().catch(() => { console.error("Restricted rehearsal unavailable; inspect private configuration and report."); process.exitCode = 1; });
