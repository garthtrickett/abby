import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresClinikoApprovalStore } from "../../src/storage/postgres-cliniko-approval-store.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { seedSyntheticCatalogueApproval } from "./seed-synthetic-catalogue-approval.ts";
import { waitForVoiceListener } from "./child-voice-listener.ts";
import { compiledRuntimeEntrypoint } from "./compiled-runtime-entrypoint.ts";
import { resultValue } from "./agent-appointment-proposals.ts";
import { voiceUntil } from "./cliniko-workflow-voice.ts";
import type { LocationScope } from "../../src/core/model.ts";

type Message = { kind: string; actionStatus?: string; text?: string; method?: string; path?: string; body?: Record<string, unknown>;
  originalActive?: boolean; replacementActive?: boolean;
  phase?: string; elapsedMs?: number;
  stage?: "fixtureProcessKilled" | "runnerStartupUnavailable";
  locations?: readonly { scope: LocationScope; policyVersion: string; businessId: string }[];
  messages?: number; envelopeMatches?: boolean; codeMatches?: boolean; email?: string; code?: string; scope?: LocationScope; policyVersion?: string; operation?: string; allowed?: boolean; accepted?: boolean; verified?: boolean };
export type ClinicalRunnerOperation = "book" | "cancel" | "reschedule" | "intake" | "patientUpdate" | "confirmationResend" | "appointments.read" | "staff.request";

/** Actual compiled runner in a separate process and database. All network
 * providers are fixtures; private caller material is kept in this test memory. */
export async function withClinicalRunner(operation: ClinicalRunnerOperation,
  run: (call: Awaited<ReturnType<typeof start>>) => Promise<void>, options: { classDateCorrection?: boolean; differentClass?: boolean; multipleClasses?: boolean; classes?: boolean; taskSequence?: boolean; resendContent?: "telehealth" | "cancelled"; intakeFields?: boolean; services?: boolean; smtp?: boolean; locations?: boolean; longSearch?: boolean; offlineCalendar?: boolean; missingBusy?: boolean; practitionerMove?: "changedTime" | "sameTime" | "directory" } = {}): Promise<void> {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl), name = `abby_test_voice_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let db: ReturnType<typeof connectPostgres> | undefined, call: Awaited<ReturnType<typeof start>> | undefined, created = false;
  let originalFailure: unknown;
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    call = await start(operation, target.toString(), db, options); await run(call);
  } catch (error) { originalFailure = error; throw error; }
  finally {
    const failures: unknown[] = [];
    try { await call?.close(); } catch (error) { failures.push(error); }
    try { await db?.destroy(); } catch (error) { failures.push(error); }
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); } catch (error) { failures.push(error); }
    try { await admin.destroy(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(originalFailure === undefined ? failures : [originalFailure, ...failures], "clinical runner test or cleanup failed");
  }
}
async function start(operation: ClinicalRunnerOperation, connectionString: string, db: ReturnType<typeof connectPostgres>, options: { classDateCorrection?: boolean; differentClass?: boolean; multipleClasses?: boolean; classes?: boolean; taskSequence?: boolean; resendContent?: "telehealth" | "cancelled"; intakeFields?: boolean; services?: boolean; smtp?: boolean; locations?: boolean; longSearch?: boolean; offlineCalendar?: boolean; missingBusy?: boolean; practitionerMove?: "changedTime" | "sameTime" | "directory" }) {
  const accountSid = `AC${"1".repeat(32)}`, authToken = "synthetic-clinical-runner-token", number = "+6125550199", caller = "+61400111222";
  const webhookUrl = "https://clinical-runner.example.test/twilio/inbound", streamUrl = "wss://clinical-runner.example.test/twilio/media/";
  const messages: Message[] = [], output: string[] = [];
  const child = spawn(process.execPath, [compiledRuntimeEntrypoint(options.classes ? "test/support/start-synthetic-class-runner.ts" : operation === "confirmationResend" ? "test/support/start-synthetic-resend-runner.ts" : "test/support/start-synthetic-clinical-runner.ts")], {
    cwd: new URL("../../", import.meta.url), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, DATABASE_URL: connectionString, ABBY_ISOLATED_POSTGRES_PROBE: "1", ABBY_VOICE_TEST_MODE: "1", ABBY_VOICE_PORT: "0",
      ABBY_SYNTHETIC_CLINICAL_OPERATION: operation,
      ABBY_SYNTHETIC_MULTIPLE_CLASSES: options.multipleClasses ? "1" : undefined,
      ABBY_SYNTHETIC_DIFFERENT_CLASS: options.differentClass ? "1" : undefined,
      ABBY_SYNTHETIC_CLASS_DATE_CORRECTION: options.classDateCorrection ? "1" : undefined,
      ABBY_SYNTHETIC_TASK_SEQUENCE: options.taskSequence ? "1" : undefined,
      ABBY_SYNTHETIC_RESEND_CONTENT: options.resendContent,
      ABBY_SYNTHETIC_LOCATION_MODE: options.locations ? "1" : undefined,
      ABBY_SYNTHETIC_INTAKE_FIELDS: options.intakeFields ? "1" : undefined,
      ABBY_SYNTHETIC_LONG_SEARCH_MODE: options.longSearch ? "1" : undefined,
      ABBY_SYNTHETIC_OFFLINE_CALENDAR: options.offlineCalendar ? "1" : undefined,
      ABBY_SYNTHETIC_MISSING_BUSY: options.missingBusy ? "1" : undefined,
      ABBY_SYNTHETIC_PRACTITIONER_MOVE: options.practitionerMove,
      ABBY_SYNTHETIC_SERVICE_MODE: options.services ? "1" : undefined, ABBY_SYNTHETIC_SMTP_MODE: options.smtp ? "1" : undefined, ABBY_TENANT_ID: "pending", ABBY_CLINIC_ID: "clinic", ABBY_LOCATION_ID: "main",
      ABBY_TWILIO_TEST_CALLER_NUMBER: caller, ABBY_TWILIO_TEST_NUMBER: number, ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
      ABBY_TWILIO_ACCOUNT_SID: accountSid, ABBY_TWILIO_AUTH_TOKEN: authToken, ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32),
      ABBY_TWILIO_PUBLIC_WEBHOOK_URL: webhookUrl, ABBY_TWILIO_PUBLIC_STREAM_URL: streamUrl, ABBY_VOICE_ROUTE_VERSION: "clinical-runner-v1",
      ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.test",
      ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
      ABBY_GREETING_VERSION: "synthetic-greeting-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-owner",
      ABBY_GREETING_APPROVED_TEXT: "This is an Abby test call. Press 1 for possible times today. Press 2 for possible times tomorrow.",
      ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0", ABBY_VOICE_OPERATIONS_TOKEN_HEX: undefined } });
  child.on("message", value => { if (value && typeof value === "object" && "kind" in value) messages.push(value as Message); });
  child.stdout!.on("data", data => output.push(data.toString())); child.stderr!.on("data", data => output.push(data.toString()));
  let socket: WebSocket | undefined, closed = false, sequence = 1, chunk = 0;
  const close = async () => {
    if (closed) return; closed = true;
    if (socket && socket.readyState !== WebSocket.CLOSED) { socket.terminate(); await once(socket, "close"); }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try { assert.equal((await exited)[0], 0, "compiled runner closes cleanly"); } finally { clearTimeout(timeout); }
    }
  };
  try {
    const port = await waitForVoiceListener(child);
    const fixture = messages.find(m => m.kind === "fixtureReady"); assert.ok(fixture?.scope && fixture.policyVersion);
    const scope = fixture.scope;
    const locations = fixture.locations ?? [{ scope, policyVersion: fixture.policyVersion, businessId: "11" }];
    for (const location of locations) await seedSyntheticCatalogueApproval(db, { ...location, accountRef: accountSid, dialedNumber: number, routeVersion: "clinical-runner-v1",
      apiKey: "synthetic-key-au5" });
    const callSid = `CA${randomUUID().replaceAll("-", "")}`, streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
    const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: caller };
    const signedWebhook = (from = caller) => {
      const body = { ...form, From: from };
      return fetch(`http://127.0.0.1:${port}/twilio/inbound`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, body) }, body: new URLSearchParams(body) });
    };
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
    assert.equal((await signedWebhook("+6145550198")).status, 503, "host cannot admit another caller");
    const response = await signedWebhook(); assert.equal(response.status, 200);
    const binding = /<Parameter name="abbyBinding" value="([^"]+)"/.exec(await response.text())?.[1]; assert.ok(binding);
    socket = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, { headers: { "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}) } });
    const wire: { event: string; mark?: { name: string } }[] = [], ack = new Set<string>(); socket.on("message", data => wire.push(JSON.parse(data.toString())));
    await once(socket, "open"); socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    const send = (event: object) => socket!.send(JSON.stringify({ ...event, streamSid, sequenceNumber: String(sequence++) }));
    send({ event: "start", start: { accountSid, callSid, streamSid, tracks: ["inbound"], customParameters: { abbyBinding: binding }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } });
    const count = (kind: string) => messages.filter(m => m.kind === kind).length;
    const say = async (text: string, privateField = false, expectFailure = false) => {
      const accepted = privateField ? "privateInputAccepted" : "inputAccepted", beforeAccepted = count(accepted), beforeSpeech = count("speech");
      child.send({ kind: privateField ? "privateInput" : "input", text }); await voiceUntil(() => count(accepted) > beforeAccepted, "caller input reaches runner");
      if (options.locations) {
        const beforeClock = count("clockAdvanced"); child.send({ kind: "advanceClock", milliseconds: (chunk + 42) * 20 });
        await voiceUntil(() => count("clockAdvanced") > beforeClock, "shared-number synthetic media clock");
      }
      // The real runner retains its 700 ms end-of-turn silence threshold.
      // Two voiced frames plus 800 ms of silence complete the actual turn.
      for (let i = 0; i < 42; i++) media(i < 2);
      await voiceUntil(() => count("speech") > beforeSpeech || child.exitCode !== null || (expectFailure && socket!.readyState === WebSocket.CLOSED), "clinical runner response", 20_000);
      assert.equal(child.exitCode, null);
    };
    const media = (voiced: boolean) => send({ event: "media", media: { track: "inbound", chunk: String(++chunk), timestamp: String((chunk - 1) * 20), payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } });
    const mark = async () => {
      await voiceUntil(() => wire.some(m => m.event === "mark" && m.mark && !ack.has(m.mark.name)), "runner playback mark");
      const m = wire.filter(m => m.event === "mark" && m.mark && !ack.has(m.mark.name)).at(-1)!.mark!; ack.add(m.name); send({ event: "mark", mark: m });
    };
    await mark();
    return { child, messages, output, scope, locations, db, mark, say, media, close, signedWebhook,
      async keypad(entry: string) { for (const digit of entry) send({ event: "dtmf", dtmf: { track: "inbound_track", digit } }); },
      async quietAfterPrivateInput() { for (let i = 0; i < 40; i++) { media(false); await new Promise<void>(resolve => setTimeout(resolve, 20)); } },
      get spoken() { return messages.filter(m => m.kind === "speech").map(m => m.text!); },
      get mutations() { return messages.filter(m => m.kind === "providerMutation"); },
      async digit(digit: string) { const before = count("speech"); send({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => count("speech") > before, "private runner prompt"); },
      async verify(expected = true) { const resultsBefore = count("verificationResult"); await voiceUntil(() => count("verificationEmail") > 0, "runner verification mail"); const mail = messages.filter(m => m.kind === "verificationEmail").at(-1)!;
        assert.ok(mail.code); for (const digit of `${mail.code}#`) send({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        await voiceUntil(() => count("verificationResult") > resultsBefore, "completed private runner verification");
        assert.equal(messages.filter(m => m.kind === "verificationResult").at(-1)!.verified, expected);
        // Actual media pacing keeps post-code speech from arriving inside the
        // private queue. No private input or code is sent to a model adapter.
        for (let i = 0; i < 40; i++) { media(false); await new Promise<void>(resolve => setTimeout(resolve, 20)); }
      },
      async revokeCatalogue(targetScope = scope) { const store = new PostgresClinikoApprovalStore(db), current = resultValue(await store.read(targetScope));
        resultValue(await store.change(targetScope, current.version, null, "synthetic-admin")); },
      async scan(values: readonly string[]) { assert.deepEqual(resultValue(await scanPatientDataCanaries(db, values.map((value, i) => ({ label: `runner_${i}`, value })))), []);
        for (const value of values) assert.equal(output.join("").includes(value), false, "runner output excludes private canaries"); },
    };
  } catch (error) {
    await close();
    const failure = messages.find(m => m.kind === "fixtureFailure");
    if (failure?.stage === "fixtureProcessKilled" || failure?.stage === "runnerStartupUnavailable") {
      throw new Error(`compiled runner fixture failed: ${failure.stage}`, { cause: error });
    }
    throw error;
  }
}
