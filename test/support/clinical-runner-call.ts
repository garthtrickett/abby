import type { ClassMoveColdContext } from "./class-move-cold-context.ts";
import { SyntheticMediaTimeline } from "./synthetic-media-timeline.ts";
import { SyntheticPlaybackReceipts } from "./synthetic-playback-receipts.ts";
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

type Message = { kind: string; coldContext?: ClassMoveColdContext; markName?: string; diagnostic?: unknown; aheadByMs?: number; actionStatus?: string; text?: string; method?: string; path?: string; body?: Record<string, unknown>;
  originalActive?: boolean; replacementActive?: boolean; sourceUsed?: number; destinationUsed?: number; caseLinked?: boolean;
  phase?: string; elapsedMs?: number;
  event?: "mark" | "dtmf"; sequence?: number; progress?: string; lifecycle?: string; pendingPresentation?: boolean;
  presentations?: readonly { kind: string; status: string }[];
  claims?: number; denialKind?: string;
  stage?: "fixtureProcessKilled" | "runnerStartupUnavailable";
  locations?: readonly { scope: LocationScope; policyVersion: string; businessId: string }[];
  messages?: number; envelopeMatches?: boolean; codeMatches?: boolean; email?: string; code?: string; scope?: LocationScope; policyVersion?: string; operation?: string; allowed?: boolean; accepted?: boolean; verified?: boolean };
export type ClinicalRunnerOperation = "book" | "cancel" | "reschedule" | "intake" | "patientUpdate" | "confirmationResend" | "appointments.read" | "staff.request";

/** Actual compiled runner in a separate process and database. All network
 * providers are fixtures; private caller material is kept in this test memory. */
export async function withClinicalRunner(operation: ClinicalRunnerOperation,
  run: (call: Awaited<ReturnType<typeof start>>) => Promise<void>, options: { adminDatabaseUrl?: string; classColdRecovery?: boolean; classQuotaStaging?: boolean; classPassHistory?: 201 | 301 | 501 | 999; classRosterHistory?: 99 | 100 | 101 | 201 | 500; classPassMovement?: "full" | "transfer"; classPasses?: boolean; classPassCancellation?: "releaseOne" | "unchanged" | "consumeOne"; recurringBusy?: "approved" | "legacy"; recurringOpening?: "approved" | "legacy"; classDateCorrection?: boolean; differentClass?: boolean; multipleClasses?: boolean; classes?: boolean; taskSequence?: boolean; resendContent?: "telehealth" | "cancelled"; intakeFields?: boolean; services?: boolean; smtp?: boolean; locations?: boolean; longSearch?: boolean; offlineCalendar?: boolean; missingBusy?: boolean; practitionerMove?: "changedTime" | "sameTime" | "directory" } = {}): Promise<void> {
  const adminUrl = options.adminDatabaseUrl ?? process.env.DATABASE_URL; assert.ok(adminUrl);
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
async function start(operation: ClinicalRunnerOperation, connectionString: string, db: ReturnType<typeof connectPostgres>, options: { classColdRecovery?: boolean; classQuotaStaging?: boolean; classPassHistory?: 201 | 301 | 501 | 999; classRosterHistory?: 99 | 100 | 101 | 201 | 500; classPassMovement?: "full" | "transfer"; classPasses?: boolean; classPassCancellation?: "releaseOne" | "unchanged" | "consumeOne"; recurringBusy?: "approved" | "legacy"; recurringOpening?: "approved" | "legacy"; classDateCorrection?: boolean; differentClass?: boolean; multipleClasses?: boolean; classes?: boolean; taskSequence?: boolean; resendContent?: "telehealth" | "cancelled"; intakeFields?: boolean; services?: boolean; smtp?: boolean; locations?: boolean; longSearch?: boolean; offlineCalendar?: boolean; missingBusy?: boolean; practitionerMove?: "changedTime" | "sameTime" | "directory" }) {
  if (options.classColdRecovery && (!options.classQuotaStaging || !options.classes)) throw new Error("staged class cold recovery fixture required");
  if (options.classQuotaStaging && (!options.classes || operation !== "reschedule")) throw new Error("staged class runner requires class rescheduling");
  const accountSid = `AC${"1".repeat(32)}`, authToken = "synthetic-clinical-runner-token", number = "+6125550199", caller = "+61400111222";
  const webhookUrl = "https://clinical-runner.example.test/twilio/inbound", streamUrl = "wss://clinical-runner.example.test/twilio/media/";
  const messages: Message[] = [], output: string[] = [];
  const child = spawn(process.execPath, [compiledRuntimeEntrypoint(options.classes ? "test/support/start-synthetic-class-runner.ts" : operation === "confirmationResend" ? "test/support/start-synthetic-resend-runner.ts" : "test/support/start-synthetic-clinical-runner.ts")], {
    cwd: new URL("../../", import.meta.url), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, DATABASE_URL: connectionString, ABBY_ISOLATED_POSTGRES_PROBE: "1", ABBY_VOICE_TEST_MODE: "1", ABBY_VOICE_PORT: "0",
      ABBY_SYNTHETIC_CLINICAL_OPERATION: operation,
      ABBY_SYNTHETIC_CLASS_QUOTA_STAGING: options.classQuotaStaging ? "1" : undefined,
      ABBY_SYNTHETIC_CLASS_COLD_RECOVERY: options.classColdRecovery ? "1" : undefined,
      ABBY_SYNTHETIC_MULTIPLE_CLASSES: options.multipleClasses ? "1" : undefined,
      ABBY_SYNTHETIC_CLASS_PASSES: options.classPasses ? "1" : undefined,
      ABBY_SYNTHETIC_CLASS_PASS_MOVE: options.classPassMovement,
      ABBY_SYNTHETIC_CLASS_PASS_HISTORY: options.classPassHistory === undefined ? undefined : String(options.classPassHistory),
      ABBY_SYNTHETIC_CLASS_ROSTER_HISTORY: options.classRosterHistory === undefined ? undefined : String(options.classRosterHistory),
      ABBY_SYNTHETIC_CLASS_PASS_CANCELLATION: options.classPassCancellation,
      ABBY_SYNTHETIC_DIFFERENT_CLASS: options.differentClass ? "1" : undefined,
      ABBY_SYNTHETIC_CLASS_DATE_CORRECTION: options.classDateCorrection ? "1" : undefined,
      ABBY_SYNTHETIC_TASK_SEQUENCE: options.taskSequence ? "1" : undefined,
      ABBY_SYNTHETIC_RESEND_CONTENT: options.resendContent,
      ABBY_SYNTHETIC_LOCATION_MODE: options.locations ? "1" : undefined,
      ABBY_SYNTHETIC_INTAKE_FIELDS: options.intakeFields ? "1" : undefined,
      ABBY_SYNTHETIC_LONG_SEARCH_MODE: options.longSearch ? "1" : undefined,
      ABBY_SYNTHETIC_OFFLINE_CALENDAR: options.offlineCalendar ? "1" : undefined,
      ABBY_SYNTHETIC_RECURRING_BUSY: options.recurringBusy,
      ABBY_SYNTHETIC_RECURRING_OPENING: options.recurringOpening,
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
  let transportCloseCode: number | undefined;
  const stagedMedia = options.classQuotaStaging ? new SyntheticMediaTimeline() : undefined;
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
    const send = (event: object) => socket!.send(JSON.stringify({ ...event, streamSid, sequenceNumber: String(sequence++) }));
    let lastSentMark: string | undefined;
    const playback = new SyntheticPlaybackReceipts(name => { lastSentMark = name; send({ event: "mark", mark: { name } }); });
    socket.on("close", code => { transportCloseCode = code; });
    socket.on("message", data => { if (!closed) playback.receive(JSON.parse(data.toString())); });
    await once(socket, "open"); socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    send({ event: "start", start: { accountSid, callSid, streamSid, tracks: ["inbound"], customParameters: { abbyBinding: binding }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } });
    const count = (kind: string) => messages.filter(m => m.kind === kind).length;
    const wireDiagnostic = () => ({ socket: socket?.readyState, closeCode: transportCloseCode, childExit: child.exitCode,
      playback: { marks: playback.count, outstanding: playback.hasPendingAfter() },
      turns: Object.fromEntries(["inputAccepted", "ordinaryFrame", "ordinaryFinal", "modelTurn", "speech"].map(kind => [kind, count(kind)])),
      results: ["privateMenuStarted", "privateMenuResult", "privateMenuPlayback", "privateChoiceStarted", "privateChoiceResult"].map(kind => ({ kind, count: count(kind), accepted: messages.filter(row => row.kind === kind).at(-1)?.accepted })),
      sources: messages.filter(row => row.kind === "resendSourceDiagnostic" || row.kind === "privateChoiceResult").at(-1)?.diagnostic,
      wire: messages.filter(row => row.kind === "wireProcessed").slice(-16).map(row => ({ event: row.event, sequence: row.sequence,
        accepted: row.accepted, progress: row.progress, lifecycle: row.lifecycle, pendingPresentation: row.pendingPresentation, presentations: row.presentations })) });
    const say = async (text: string, privateField = false, expectFailure = false) => {
      if (options.classQuotaStaging) {
        assert.ok(stagedMedia);
        const aligned = count("mediaClockAligned"); child.send({ kind: "alignMediaClock", elapsedMs: stagedMedia.nextTurnEndMs });
        await voiceUntil(() => count("mediaClockAligned") > aligned, "synthetic class media clock");
        const alignment = messages.filter(row => row.kind === "mediaClockAligned").at(-1)!;
        assert.equal(alignment.allowed, true); assert.ok(typeof alignment.elapsedMs === "number");
        stagedMedia.alignTurnEnd(alignment.elapsedMs);
      }
      let beforeState: unknown;
      if (options.classQuotaStaging && text === "Continue my class move") {
        const probes = count("classDiagnostic"); child.send({ kind: "classDiagnostic" });
        await voiceUntil(() => count("classDiagnostic") > probes || child.exitCode !== null, "class continuation state", 1000);
        beforeState = messages.filter(row => row.kind === "classDiagnostic").at(-1)?.diagnostic;
      }
      const accepted = privateField ? "privateInputAccepted" : "inputAccepted", beforeAccepted = count(accepted), beforeSpeech = count("speech"), beforeMarks = playback.count;
      child.send({ kind: privateField ? "privateInput" : "input", text }); await voiceUntil(() => count(accepted) > beforeAccepted, "caller input reaches runner");
      if (options.locations) {
        const beforeClock = count("clockAdvanced"); child.send({ kind: "advanceClock", milliseconds: (chunk + 42) * 20 });
        await voiceUntil(() => count("clockAdvanced") > beforeClock, "shared-number synthetic media clock");
      }
      // The real runner retains its 700 ms end-of-turn silence threshold.
      // Two voiced frames plus 800 ms of silence complete the actual turn.
      for (let i = 0; i < 42; i++) media(i < 2);
      try {
        await voiceUntil(() => (count("speech") > beforeSpeech && playback.hasPendingAfter(beforeMarks)) || child.exitCode !== null ||
          (expectFailure && socket!.readyState === WebSocket.CLOSED), "clinical runner response", 20_000);
      } catch (error) {
        if (!options.classQuotaStaging) {
          if (operation === "confirmationResend" && child.connected) {
            // Request current counters after the original response deadline;
            // a private-choice snapshot can predate this ordinary caller turn.
            const before = count("resendSourceDiagnostic"); child.send({ kind: "resendDiagnostics" });
            try { await voiceUntil(() => count("resendSourceDiagnostic") > before || child.exitCode !== null,
              "current fixed resend stage diagnostic", 1_000); } catch { /* Missing diagnostic remains evidence. */ }
          }
          throw new Error("Clinical response unavailable: " + JSON.stringify(wireDiagnostic()), { cause: error });
        }
        const probes = count("classDiagnostic"); child.send({ kind: "classDiagnostic" });
        try { await voiceUntil(() => count("classDiagnostic") > probes || child.exitCode !== null, "bounded class state diagnostic", 1000); } catch { /* absence is part of the diagnostic */ }
        const counts = Object.fromEntries([...new Set(messages.map(row => row.kind))].map(kind => [kind, count(kind)]));
        const trace = messages.slice(-16).map(row => ({ kind: row.kind, phase: row.phase,
          actionStatus: row.actionStatus, verified: row.verified, allowed: row.allowed }));
        throw new Error("Staged signed response unavailable: " + JSON.stringify({ socket: socket!.readyState, closeCode: transportCloseCode, childExit: child.exitCode,
          playback: { marks: playback.count, outstanding: playback.hasPendingAfter() },
          phaseAffirmation: messages.filter(row => row.kind === "classPhaseAffirmation").at(-1)?.diagnostic, counts, trace, beforeState, state: messages.filter(row => row.kind === "classDiagnostic").at(-1)?.diagnostic ?? null }), { cause: error });
      }
      assert.equal(child.exitCode, null);
    };
    const media = (voiced: boolean) => {
      const packet = stagedMedia?.next() ?? { chunk: String(++chunk), timestamp: String((chunk - 1) * 20) };
      send({ event: "media", media: { track: "inbound", ...packet, payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } });
    };
    const mark = async () => {
      const deadline = Date.now() + 10000;
      await voiceUntil(() => playback.hasPendingAfter(), "runner playback mark");
      assert.equal(playback.acknowledgeLatest(), true);
      if (options.classQuotaStaging) {
        // Wire and IPC use separate channels. Complete this real receipt before
        // the next turn advances the synthetic host clock.
        const name = lastSentMark; assert.ok(name);
        await voiceUntil(() => messages.some(row => row.kind === "classMarkProcessed" && row.markName === name),
          "processed staged playback receipt", Math.max(1, deadline - Date.now()));
        assert.equal(messages.find(row => row.kind === "classMarkProcessed" && row.markName === name)!.accepted, true);
      }
    };
    await mark();
    return { child, messages, output, scope, locations, db, connectionString, mark, say, media, close, signedWebhook,
      async endCallerForColdReview() {
        assert.equal(options.classColdRecovery, true);
        if (socket!.readyState !== WebSocket.CLOSED) { const ended = once(socket!, "close"); socket!.close(1000); await ended; }
        await voiceUntil(() => count("coldCallerDisposed") > 0, "actual compiled caller owner disposal");
      },
      async coldReviewContext() {
        assert.equal(options.classColdRecovery, true); const before = count("coldProviderContext");
        child.send({ kind: "coldProviderContext" });
        await voiceUntil(() => count("coldProviderContext") > before || count("coldProviderUnavailable") > 0, "independent cold provider bindings");
        const context = messages.filter(row => row.kind === "coldProviderContext").at(-1)?.coldContext; assert.ok(context); return context;
      },
      async coldProviderAudit() {
        assert.equal(options.classColdRecovery, true); const before = count("coldProviderAudit"); child.send({ kind: "coldProviderAudit" });
        await voiceUntil(() => count("coldProviderAudit") > before, "cold provider GET audit");
        return messages.filter(row => row.kind === "coldProviderAudit").at(-1)!.diagnostic as { reads: number; protectedReads: number; nonGet: number };
      },
      async acknowledgeColdReview() {
        assert.equal(options.classColdRecovery, true); const before = count("coldReviewAcknowledged"); child.send({ kind: "acknowledgeColdReview" });
        await voiceUntil(() => count("coldReviewAcknowledged") > before, "independent synthetic provider review acknowledgement");
      },
      async keypad(entry: string) { for (const digit of entry) send({ event: "dtmf", dtmf: { track: "inbound_track", digit } }); },
      async quietAfterPrivateInput() { for (let i = 0; i < 40; i++) { media(false); await new Promise<void>(resolve => setTimeout(resolve, 20)); } },
      get spoken() { return messages.filter(m => m.kind === "speech").map(m => m.text!); },
      get mutations() { return messages.filter(m => m.kind === "providerMutation"); },
      async digit(digit: string) { const before = count("speech"), marks = playback.count; send({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
        try { await voiceUntil(() => count("speech") > before && playback.hasPendingAfter(marks), "private runner prompt"); }
        catch (error) {
          if (operation === "confirmationResend" && child.connected) {
            const before = count("resendSourceDiagnostic");
            try {
              child.send({ kind: "resendDiagnostics" }, () => {});
              await voiceUntil(() => count("resendSourceDiagnostic") > before, "failure diagnostics only", 1_000);
            } catch { /* Diagnostics cannot replace the original deadline failure. */ }
          }
          throw new Error("Private response unavailable: " + JSON.stringify(wireDiagnostic()), { cause: error });
        } },
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
      async scan(values: readonly string[]) {
        const window = messages.find(message => message.kind === "verificationCanaryWindow")?.diagnostic as
          { sinceMs: number; throughMs: number } | undefined;
        if (window || !options.classes && operation !== "confirmationResend") {
          assert.ok(window && Number.isSafeInteger(window.sinceMs) && Number.isSafeInteger(window.throughMs));
          const rows = await db.selectFrom("cliniko_request_budgets").select("sent_at_ms").execute();
          assert.ok(rows.every(row => Array.isArray(row.sent_at_ms) &&
            (row.sent_at_ms as number[]).every(at => at >= window.sinceMs && at <= window.throughMs)),
          "all actual request timestamps stay inside the synthetic code canary window");
        }
        assert.deepEqual(resultValue(await scanPatientDataCanaries(db, values.map((value, i) => ({ label: `runner_${i}`, value })))), []);
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
