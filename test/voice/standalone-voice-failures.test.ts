import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { connectPostgres } from "../../src/storage/connect.ts";
import { seedSyntheticCatalogueApproval } from "../support/seed-synthetic-catalogue-approval.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { PostgresClinikoApprovalStore } from "../../src/storage/postgres-cliniko-approval-store.ts";

type Fault = "openai-speech" | "speech-primary-stall" | "openai-transcription" | "untrusted-transcript" | "clear-availability" | "clear-unsupported" | "clear-model-failure" | "cliniko-rate-limit" | "cliniko-server-error" | "cliniko-timeout" | "cliniko-slow-read" | "cliniko-zone-changed" | "cliniko-partial-page" | "cliniko-empty" |
  "cliniko-business-type-removed" | "cliniko-practitioner-type-removed" | "week-alternative" | "practitioner-alternative" |
  "practitioner-alternative-rate-limit" | "practitioner-alternative-malformed" |
  "practitioner-alternative-second" | "primary-selection-change" | undefined;
const fallbackScenarios = [
  { fault: "cliniko-rate-limit", id: "E2E-174" },
  { fault: "cliniko-server-error", id: "E2E-207" },
  { fault: "cliniko-timeout", id: "E2E-175" },
  { fault: "cliniko-slow-read", id: "E2E-208" },
  { fault: "cliniko-zone-changed", id: "E2E-209" },
  { fault: "cliniko-partial-page", id: "E2E-190" },
  { fault: "cliniko-business-type-removed", id: "E2E-193" },
  { fault: "cliniko-practitioner-type-removed", id: "E2E-204" },
] as const;
const number = "+6125550199";
const caller = "+6145550101";
const accountSid = `AC${"1".repeat(32)}`;
const authToken = "synthetic-token";
const operationalTokenHex = "a".repeat(64);
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";
const noStaffNotice = "I can't send a staff request from this call. Please contact the clinic directly.";
const weekInstruction = "Press 3 for possible times over the next week.";
const root = new URL("../../", import.meta.url);

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 8_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), `${label} timed out`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
}

type Call = { socket: WebSocket; messages: Record<string, unknown>[];
  closed: Promise<[number, Buffer]>; streamSid: string };
type Fixture = { port: number; child: ReturnType<typeof spawn>;
  admin: ReturnType<typeof connectPostgres>; databaseName: string;
  speech: string[]; speechRequests: { model: string; text: string }[];
  clinikoMethods: string[]; clinikoPaths: string[]; clinikoQueries: string[];
  clinikoReadAborts: { at: number; reason: string }[];
  modelRequests: string[];
  openCall: (callSidOverride?: string) => Promise<Call>; restart: () => Promise<void>;
  operationalSnapshot: () => Promise<Record<string, number>> };

async function withFixture(fault: Fault, run: (fixture: Fixture) => Promise<void>,
                           weekApproved: boolean | "default" = false, alternativeApproved = false,
                           secondAlternativeApproved = false): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const databaseName = `abby_test_voice_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const port = await freePort();
  const callSid = `CA${randomUUID().replaceAll("-", "")}`;
  const providerCallRefs = new Set([callSid]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
    DATABASE_URL: target.toString(), ABBY_ISOLATED_POSTGRES_PROBE: "1",
    ABBY_VOICE_PORT: String(port), ABBY_VOICE_TEST_MODE: "1",
    ABBY_SYNTHETIC_VOICE_FAULT: fault, ABBY_TWILIO_TEST_CALLER_NUMBER: caller,
    ABBY_TENANT_ID: "fault-test", ABBY_CLINIC_ID: "clinic", ABBY_LOCATION_ID: "main",
    ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com",
    ABBY_CLINIKO_BUSINESS_ID: undefined, ABBY_CLINIKO_PRACTITIONER_ID: undefined,
    ABBY_CLINIKO_APPOINTMENT_TYPE_ID: undefined, ABBY_CLINIKO_TIME_ZONE: undefined,
    ABBY_TWILIO_TEST_NUMBER: number, ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
    ABBY_TWILIO_ACCOUNT_SID: accountSid, ABBY_TWILIO_AUTH_TOKEN: authToken,
    ABBY_VOICE_OPERATIONS_TOKEN_HEX: operationalTokenHex,
    ABBY_TWILIO_PUBLIC_WEBHOOK_URL: webhookUrl, ABBY_TWILIO_PUBLIC_STREAM_URL: streamUrl,
    ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32), ABBY_VOICE_ROUTE_VERSION: "fault-test-v1",
    ABBY_TEST_OPERATOR_REF: "synthetic-operator", ABBY_AUTOMATION_EXPECTED_VERSION: "0",
    ABBY_GREETING_VERSION: "fault-test-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-approval",
    ABBY_GREETING_APPROVED_TEXT: `This is an Abby test call. Press 1 for possible times today. Press 2 for possible times tomorrow.${weekApproved === true ? ` ${weekInstruction}` : ""}`,
    ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: weekApproved === "default" ? undefined : weekApproved ? "1" : "0",
    ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
  };
  let created = false;
  let child: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  const speech: string[] = [];
  const speechRequests: { model: string; text: string }[] = [];
  const clinikoMethods: string[] = [];
  const clinikoPaths: string[] = [];
  const clinikoQueries: string[] = [];
  const clinikoReadAborts: { at: number; reason: string }[] = [];
  const modelRequests: string[] = [];
  let processOutput = "";
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin);
    created = true;
    const db = connectPostgres(target.toString());
    try {
      await migrate(db);
      await seedSyntheticCatalogueApproval(db, { scope: { tenantId: "fault-test", clinicId: "clinic", locationId: "main" },
        accountRef: accountSid, dialedNumber: number, routeVersion: "fault-test-v1",
        apiKey: "synthetic-key-au5",
        ...(alternativeApproved ? { alternatives: [
          { practitionerId: "44", appointmentTypeId: "55" },
          ...(secondAlternativeApproved ? [{ practitionerId: "66", appointmentTypeId: "77" }] : []),
        ] } : {}) });
    } finally { await db.destroy(); }
    const enabled = spawnSync(process.execPath, ["scripts/set-voice-test-automation.ts", "enable"],
      { cwd: root, env, encoding: "utf8", timeout: 15_000 });
    assert.equal(enabled.status, 0, enabled.stderr);
    const launch = async (): Promise<void> => {
      child = spawn(process.execPath, ["test/support/start-synthetic-voice-runner.ts"],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.on("message", message => {
        if (typeof message === "object" && message !== null && "kind" in message &&
            message.kind === "speech" && "text" in message && typeof message.text === "string" &&
            "model" in message && typeof message.model === "string") {
          speech.push(message.text);
          speechRequests.push({ model: message.model, text: message.text });
        }
        if (typeof message === "object" && message !== null && "kind" in message &&
            message.kind === "intentModelRequest") modelRequests.push("request");
        if (typeof message === "object" && message !== null && "kind" in message &&
            message.kind === "clinikoReadAborted" && "reason" in message &&
            typeof message.reason === "string") clinikoReadAborts.push({ at: Date.now(), reason: message.reason });
        if (typeof message === "object" && message !== null && "kind" in message &&
            message.kind === "clinikoMethod" && "method" in message && typeof message.method === "string") {
          clinikoMethods.push(message.method);
          if ("path" in message && typeof message.path === "string") clinikoPaths.push(message.path);
          if ("query" in message && typeof message.query === "string") clinikoQueries.push(message.query);
        }
      });
      child.stdout?.on("data", data => { processOutput += String(data); });
      child.stderr?.on("data", data => { processOutput += String(data); });
      const healthUrl = `http://127.0.0.1:${port}/healthz`;
      const until = Date.now() + 30_000;
      let healthy = false;
      while (!healthy && Date.now() < until) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        try { healthy = (await fetch(healthUrl, { signal: AbortSignal.timeout(500) })).status === 200; }
        catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      assert.ok(healthy, `voice runner did not start (exit=${child.exitCode ?? "running"}, signal=${child.signalCode ?? "none"})`);
    };
    await launch();
    const firstChild = child;
    assert.ok(firstChild);
    const restart = async (): Promise<void> => {
      if (!child || (child.exitCode === null && child.signalCode === null)) {
        throw new Error("voice runner must exit before restart");
      }
      await launch();
    };
    const openCall = async (callSidOverride = callSid): Promise<Call> => {
      providerCallRefs.add(callSidOverride);
      const form = { AccountSid: accountSid, CallSid: callSidOverride, To: number, From: caller };
      const answer = await fetch(`http://127.0.0.1:${port}/twilio/inbound`, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form) },
        body: new URLSearchParams(form) });
      assert.equal(answer.status, 200);
      const xml = await answer.text();
      assert.ok(xml.endsWith("</Connect><Dial>+6125550188</Dial></Response>"));
      const binding = xml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
      assert.ok(binding);
      socket = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, { headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
      } });
      await bounded(once(socket, "open"), "signed stream open");
      const closed = once(socket, "close") as Promise<[number, Buffer]>;
      const messages: Record<string, unknown>[] = [];
      socket.on("message", data => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
      const streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
        start: { accountSid, callSid: callSidOverride, streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
      return { socket, messages, closed, streamSid };
    };
    const operationalSnapshot = async (): Promise<Record<string, number>> => {
      const response = await bounded(fetch(`http://127.0.0.1:${port}/internal/operations`, { headers: {
        authorization: `Bearer ${operationalTokenHex}` } }), "operational snapshot");
      assert.equal(response.status, 200);
      return await response.json() as Record<string, number>;
    };
    await run({ port, child: firstChild, admin, databaseName, speech, speechRequests, clinikoMethods, clinikoPaths,
      clinikoQueries, clinikoReadAborts, modelRequests, openCall, restart, operationalSnapshot });
  } finally {
    let restored = true;
    try { if (created) await sql.raw(`alter database "${databaseName}" with allow_connections true`).execute(admin); }
    catch { restored = false; }
    try {
      socket?.terminate();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await bounded(exited, "voice runner shutdown");
      }
      assert.ok(restored, "isolated database connections could not be restored");
      if (created) {
        const canaries = [
          { label: "caller", value: caller },
          ...[...providerCallRefs].map((value, index) => ({ label: `provider_call_${index}`, value })),
          { label: "appointment", value: "synthetic-only" },
          { label: "transcript", value: "Do you have availability tomorrow?" },
          { label: "unsupported_transcript", value: "Please book my appointment tomorrow." },
        ];
        const db = connectPostgres(target.toString());
        try { assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] }); }
        finally { await db.destroy(); }
        assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
        for (const canary of canaries) assert.ok(!processOutput.includes(canary.value), `${canary.label} appeared in runner output`);
      }
    } finally {
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  }
}

async function markGreeting(call: Call): Promise<void> {
  await waitFor(() => call.messages.length >= 2, "greeting playback");
  assert.deepEqual(call.messages.slice(0, 2).map(item => item.event), ["media", "mark"]);
  call.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid: call.streamSid,
    mark: { name: (call.messages[1]!.mark as { name: string }).name } }));
}

async function sendSyntheticSpokenTurn(call: Call): Promise<void> {
  for (let index = 0; index < 37; index += 1) {
    call.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(3 + index),
      streamSid: call.streamSid, media: { track: "inbound", chunk: String(1 + index),
        timestamp: String(index * 20),
        payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
    await new Promise(resolve => setTimeout(resolve, 3));
  }
}

function assertResponseAudio(call: Call): void {
  const first = (call.messages[0]?.media as { payload?: string } | undefined)?.payload;
  const second = (call.messages[2]?.media as { payload?: string } | undefined)?.payload;
  assert.ok(first && second);
  assert.notEqual(second, first, "the caller must hear a response, not the greeting again");
}

async function closeCaller(call: Call): Promise<void> {
  call.socket.close(1000);
  assert.equal((await bounded(call.closed, "caller close"))[0], 1000);
}

test("isolated signed runner failure paths", { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1",
  timeout: 240_000, concurrency: 5 }, async t => {
  await Promise.all([
    t.test("E2E-236 signed clear availability turn reads provisional Cliniko times", async () =>
      withFixture("clear-availability", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        await sendSyntheticSpokenTurn(call);
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "clear availability response");
        assertResponseAudio(call);
        assert.deepEqual(fixture.modelRequests, ["request"]);
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        assert.match(fixture.speech[1]!, /possible|available/i);
        assert.doesNotMatch(fixture.speech[1]!, /booked|reserved|confirmed/i);
        await closeCaller(call);
      })),
    t.test("E2E-236 signed clear booking request cannot read times or make a write", async () =>
      withFixture("clear-unsupported", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        await sendSyntheticSpokenTurn(call);
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "unsupported fallback");
        assertResponseAudio(call);
        assert.deepEqual(fixture.modelRequests, ["request"]);
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 0);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        assert.match(fixture.speech[1]!, /contact the clinic directly/i);
        assert.doesNotMatch(fixture.speech[1]!, /booked|reserved|confirmed/i);
        await closeCaller(call);
      })),
    t.test("E2E-236 signed clear model failure closes without a Cliniko read or claim", async () =>
      withFixture("clear-model-failure", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        await sendSyntheticSpokenTurn(call);
        assert.equal((await bounded(call.closed, "model failure close"))[0], 1008);
        assert.deepEqual(fixture.modelRequests, ["request"]);
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 0);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        assert.equal(fixture.speech.length, 1);
      })),
    ...[false, true].map(alternativeApproved =>
      t.test(`E2E-200 signed empty availability with approved alternative ${alternativeApproved}`, async () =>
        withFixture("cliniko-empty", async fixture => {
          const call = await fixture.openCall();
          await markGreeting(call);
          call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
            dtmf: { track: "inbound_track", digit: "2" } }));
          await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "empty availability response");
          assert.deepEqual(call.messages.map(item => item.event), ["media", "mark", "media", "mark"]);
          assert.equal(fixture.speech[1],
            "I couldn't find a possible appointment time for those dates. Please contact the clinic directly.");
          assert.ok(!fixture.speech.some(text => text.includes("10:00") || text.includes("synthetic-only") ||
            text.includes("reserve") || text.includes("confirm")));
          assert.deepEqual(fixture.clinikoPaths.filter(path => path.endsWith("/available_times"))
            .map(path => path.includes("/practitioners/44/") ? "alternative" : "primary"),
          alternativeApproved ? ["primary", "alternative"] : ["primary"]);
          assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
          await closeCaller(call);
        }, false, alternativeApproved))),
    ...fallbackScenarios.map(({ fault, id }) =>
      t.test(`${id} safe spoken fallback on ${fault}`,
        async () => withFixture(fault, async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "1" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2,
          "safe availability response", fault === "cliniko-slow-read" ? 25_000 : 8_000);
        assert.deepEqual(call.messages.slice(2, 4).map(item => item.event), ["media", "mark"]);
        assert.equal(fixture.speech[1], noStaffNotice);
        assert.ok(!fixture.speech.some(text => text.includes("10:00") || text.includes("synthetic-only")));
        assert.ok(fixture.clinikoMethods.length > 0 && fixture.clinikoMethods.every(method => method === "GET"));
        if (fault === "cliniko-partial-page") {
          assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        }
        if (fault === "cliniko-server-error") {
          assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
          const counts = await fixture.operationalSnapshot();
          assert.equal(counts.clinikoProvider429, 0);
          assert.equal(counts.clinikoProviderUnavailable, 1);
        }
        if (fault === "cliniko-timeout" || fault === "cliniko-slow-read") {
          const counts = await fixture.operationalSnapshot();
          assert.equal(counts.clinikoProviderUnavailable, 1);
        }
        if (fault === "cliniko-slow-read") {
          assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        }
        if (fault === "cliniko-zone-changed") {
          assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        }
        if (fault === "cliniko-rate-limit") {
          const counts = await fixture.operationalSnapshot();
          assert.equal(counts.clinikoProvider429, 1);
          assert.equal(counts.clinikoProviderUnavailable, 0);
          assert.equal(counts.clinikoBudgetDenied, 0);
          assert.equal(counts.clinikoBudgetUnavailable, 0);
          assert.equal(JSON.stringify(counts).includes(caller), false);
        }
        if (fault === "cliniko-business-type-removed") {
          assert.deepEqual(fixture.clinikoPaths, ["/v1/businesses/11"]);
        }
        if (fault === "cliniko-practitioner-type-removed") {
          assert.deepEqual(fixture.clinikoPaths, [
            "/v1/businesses/11", "/v1/practitioners/22", "/v1/appointment_types/33",
            "/v1/businesses/11/practitioners", "/v1/practitioners/22/appointment_types",
          ]);
          assert.equal(fixture.clinikoPaths.some(path => path.endsWith("/available_times")), false);
        }
        await closeCaller(call);
      }))),
    t.test("E2E-173 OpenAI greeting failure closes before audio", async () => withFixture("openai-speech", async fixture => {
      const call = await fixture.openCall();
      assert.equal((await bounded(call.closed, "speech failure close"))[0], 1008);
      assert.deepEqual(call.messages, []);
      assert.equal(fixture.speech.length, 1);
      const counts = await fixture.operationalSnapshot();
      assert.equal(counts.callOwnerStarted, 1);
      assert.equal(counts.voiceFailure, 1);
      assert.equal(counts.callEnded, 1);
      assert.equal(JSON.stringify(counts).includes(caller), false);
    })),
    t.test("E2E-151 stalled primary speaks one fallback greeting and one distinct answer", async () =>
      withFixture("speech-primary-stall", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        await waitFor(() => fixture.speechRequests.length >= 2, "greeting speech requests");
        const greeting = fixture.speechRequests[0]!.text;
        assert.match(greeting, /Press 1 for possible times today/);
        assert.deepEqual(fixture.speechRequests.slice(0, 2), [
          { model: "synthetic-primary-stalled", text: greeting },
          { model: "synthetic-fallback", text: greeting },
        ]);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "1" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speechRequests.length >= 4,
          "fallback availability answer");
        assert.deepEqual(call.messages.map(item => item.event), ["media", "mark", "media", "mark"]);
        assertResponseAudio(call);
        const answer = fixture.speechRequests[2]!.text;
        assert.match(answer, /These may change/);
        assert.match(answer, /can't reserve or confirm/);
        assert.deepEqual(fixture.speechRequests.slice(2), [
          { model: "synthetic-primary-stalled", text: answer },
          { model: "synthetic-fallback", text: answer },
        ]);
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        await closeCaller(call);
      })),
    t.test("E2E-196 transcription failure closes the signed stream without a new claim", async () =>
      withFixture("openai-transcription", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        for (let index = 0; index < 3; index += 1) call.socket.send(JSON.stringify({ event: "media",
          sequenceNumber: String(index + 3), streamSid: call.streamSid,
          media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20),
            payload: Buffer.alloc(160, 0x9f).toString("base64") } }));
        assert.equal((await bounded(call.closed, "transcription failure close"))[0], 1008);
        assert.deepEqual(fixture.speech, [
          "This is an Abby test call. Press 1 for possible times today. Press 2 for possible times tomorrow.",
        ]);
        assert.deepEqual(fixture.clinikoMethods, []);
      })),
    t.test("E2E-205 signed completed transcripts stay untrusted and never reach the intent model", async () =>
      withFixture("untrusted-transcript", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        const priorClinikoReads = fixture.clinikoMethods.length;
        const sendTurn = async (sequence: number, chunk: number): Promise<void> => {
          for (let index = 0; index < 37; index += 1) {
            call.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(sequence + index),
              streamSid: call.streamSid, media: { track: "inbound", chunk: String(chunk + index),
                timestamp: String((chunk + index - 1) * 20),
                payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
            await new Promise(resolve => setTimeout(resolve, 3));
          }
        };
        await sendTurn(3, 1);
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "unclear speech fallback");
        assert.equal(fixture.speech[1], "Could you repeat that for me?");
        assert.deepEqual(fixture.modelRequests, []);
        assert.equal(fixture.clinikoMethods.length, priorClinikoReads);
        call.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "40", streamSid: call.streamSid,
          mark: { name: (call.messages[3]!.mark as { name: string }).name } }));
        await sendTurn(41, 38);
        assert.equal((await bounded(call.closed, "second unclear turn close"))[0], 1008);
        assert.deepEqual(fixture.modelRequests, []);
        assert.equal(fixture.speech.length, 2);
        assert.equal(fixture.clinikoMethods.length, priorClinikoReads);
        const counts = await fixture.operationalSnapshot();
        assert.equal(counts.callOwnerStarted, 1);
        assert.equal(counts.voiceFailure, 1);
        assert.equal(counts.callEnded, 1);
      })),
    t.test("E2E-205 interrupted clarification ignores a late played mark and never speaks a stale turn", async () =>
      withFixture("untrusted-transcript", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        const sendFrame = async (sequence: number, chunk: number, voiced: boolean): Promise<void> => {
          call.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(sequence), streamSid: call.streamSid,
            media: { track: "inbound", chunk: String(chunk), timestamp: String((chunk - 1) * 20),
              payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } }));
          await new Promise(resolve => setTimeout(resolve, 3));
        };
        for (let index = 0; index < 37; index += 1) await sendFrame(3 + index, 1 + index, index < 2);
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "unplayed clarification");
        assert.equal(fixture.speech[1], "Could you repeat that for me?");
        const staleMark = (call.messages[3]!.mark as { name: string }).name;
        await sendFrame(40, 38, true);
        await sendFrame(41, 39, true);
        await waitFor(() => call.messages.length >= 6, "interruption clear");
        assert.deepEqual(call.messages.slice(4, 6).map(item => item.event), ["mark", "clear"]);
        const fenceMark = (call.messages[4]!.mark as { name: string }).name;
        call.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "42", streamSid: call.streamSid,
          mark: { name: fenceMark } }));
        call.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "43", streamSid: call.streamSid,
          mark: { name: staleMark } }));
        for (let index = 0; index < 35; index += 1) await sendFrame(44 + index, 40 + index, false);
        assert.equal((await bounded(call.closed, "second unclear turn close"))[0], 1008);
        assert.deepEqual(call.messages.map(item => item.event), ["media", "mark", "media", "mark", "mark", "clear"]);
        assert.deepEqual(fixture.modelRequests, []);
        assert.equal(fixture.speech.length, 2);
        assert.equal(fixture.clinikoMethods.length, 0);
      })),
    t.test("E2E-199 an unapproved week option and invalid digit cannot widen a caller's read", async () =>
      withFixture("week-alternative", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        for (const [digit, sequenceNumber] of [["3", "3"], ["9", "4"], ["1", "5"]]) {
          call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber, streamSid: call.streamSid,
            dtmf: { track: "inbound_track", digit } }));
        }
        await waitFor(() => call.messages.length >= 4 &&
          fixture.speech.some(text => /couldn't find a possible appointment time/.test(text)), "single-day response");
        assert.deepEqual(call.messages.map(item => item.event), ["media", "mark", "media", "mark"]);
        assertResponseAudio(call);
        assert.ok(fixture.speech.some(text => /couldn't find a possible appointment time/.test(text)));
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        const readIndex = fixture.clinikoPaths.findIndex(path => path.endsWith("/available_times"));
        const query = new URLSearchParams(fixture.clinikoQueries[readIndex]);
        assert.equal(query.get("from"), query.get("to"));
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        await closeCaller(call);
      })),
    t.test("E2E-199 omitted week setting defaults off for a signed caller", async () =>
      withFixture("week-alternative", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        await waitFor(() => fixture.speech.length > 0, "default greeting speech request");
        assert.ok(!fixture.speech[0]?.includes(weekInstruction));
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "3" } }));
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "4", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "1" } }));
        await waitFor(() => call.messages.length >= 4 &&
          fixture.speech.some(text => /couldn't find a possible appointment time/.test(text)),
        "default one-day response");
        assertResponseAudio(call);
        assert.ok(fixture.speech.some(text => /couldn't find a possible appointment time/.test(text)));
        const readIndex = fixture.clinikoPaths.findIndex(path => path.endsWith("/available_times"));
        assert.ok(readIndex >= 0);
        const query = new URLSearchParams(fixture.clinikoQueries[readIndex]);
        assert.equal(query.get("from"), query.get("to"));
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        await closeCaller(call);
      }, "default")),
    t.test("E2E-199 an approved week option speaks only a bounded provisional alternative", async () =>
      withFixture("week-alternative", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        await waitFor(() => fixture.speech.length > 0, "approved week greeting speech request");
        assert.ok(fixture.speech[0]?.includes(weekInstruction));
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "3" } }));
        await waitFor(() => call.messages.length >= 4 &&
          fixture.speech.some(text => text.includes("These may change")), "week alternative response");
        assert.deepEqual(call.messages.map(item => item.event), ["media", "mark", "media", "mark"]);
        assertResponseAudio(call);
        const response = fixture.speech.find(text => text.includes("These may change"))!;
        assert.match(response, /possible times/);
        assert.match(response, /These may change/);
        assert.match(response, /can't reserve or confirm/);
        assert.ok(!response.includes(noStaffNotice));
        const readIndex = fixture.clinikoPaths.findIndex(path => path.endsWith("/available_times"));
        assert.ok(readIndex >= 0);
        const query = new URLSearchParams(fixture.clinikoQueries[readIndex]);
        const from = query.get("from");
        const to = query.get("to");
        assert.ok(from && to);
        assert.equal(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`), 6 * 86_400_000);
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        await closeCaller(call);
      }, true)),
    t.test("E2E-199 enabled week search speaks only direct contact after provider rate limit", async () =>
      withFixture("cliniko-rate-limit", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        await waitFor(() => fixture.speech.length > 0, "rate-limit greeting speech request");
        assert.ok(fixture.speech[0]?.includes(weekInstruction));
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "3" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speech.includes(noStaffNotice),
          "week rate-limit fallback");
        assertResponseAudio(call);
        assert.ok(fixture.speech.includes(noStaffNotice));
        assert.ok(fixture.clinikoMethods.length > 0 && fixture.clinikoMethods.every(method => method === "GET"));
        await closeCaller(call);
      }, true)),
    t.test("E2E-200 unapproved practitioner and type are never searched", async () =>
      withFixture("practitioner-alternative", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "2" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "default availability response");
        assert.match(fixture.speech[1]!, /couldn't find a possible appointment time/);
        assert.equal(fixture.clinikoPaths.some(path => path.includes("/44") || path.includes("/55")), false);
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        await closeCaller(call);
      })),
    t.test("E2E-200 approved alternative is named and provisional in a signed call", async () =>
      withFixture("practitioner-alternative", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "2" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "approved alternative response");
        assert.match(fixture.speech[1]!, /For Follow up with Dr Alternative, the clinic's schedule currently shows possible times/);
        assert.match(fixture.speech[1]!, /These may change. I can't reserve or confirm/);
        assert.deepEqual(fixture.clinikoPaths.filter(path => path.endsWith("/available_times"))
          .map(path => path.includes("/practitioners/44/") ? "alternative" : "primary"),
        ["primary", "alternative"]);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        await closeCaller(call);
      }, false, true)),
    t.test("E2E-200 the second ordered alternative is searched only after the first is empty", async () =>
      withFixture("practitioner-alternative-second", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "2" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "second alternative response");
        assert.match(fixture.speech[1]!, /For Review with Dr Third, the clinic's schedule currently shows possible times/);
        assert.match(fixture.speech[1]!, /can't reserve or confirm/);
        assert.deepEqual(fixture.clinikoPaths.filter(path => path.endsWith("/available_times"))
          .map(path => path.includes("/practitioners/66/") ? "second" :
            path.includes("/practitioners/44/") ? "first" : "primary"),
        ["primary", "first", "second"]);
        await closeCaller(call);
      }, false, true, true)),
    t.test("E2E-200 alternative rate limit gives only the direct-contact fallback", async () =>
      withFixture("practitioner-alternative-rate-limit", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "2" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "alternative failure response");
        assert.equal(fixture.speech[1], noStaffNotice);
        assert.ok(!fixture.speech.some(text => text.includes("Dr Alternative") || text.includes("Follow up")));
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 2);
        await closeCaller(call);
      }, false, true)),
    t.test("E2E-200 malformed alternative name cannot be spoken", async () =>
      withFixture("practitioner-alternative-malformed", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "2" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "malformed alternative response");
        assert.equal(fixture.speech[1], noStaffNotice);
        assert.ok(!fixture.speech.some(text => text.includes("Dr Alternative") || text.includes("Follow up")));
        assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        await closeCaller(call);
      }, false, true)),
    t.test("E2E-210 next signed call follows a changed approved primary without runner restart", async () =>
      withFixture("primary-selection-change", async fixture => {
        const first = await fixture.openCall();
        await markGreeting(first);
        first.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: first.streamSid,
          dtmf: { track: "inbound_track", digit: "2" } }));
        await waitFor(() => first.messages.length >= 4 && fixture.speech.length >= 2, "first primary response");
        assert.match(fixture.speech[1]!, /couldn't find a possible appointment time/);
        assert.deepEqual(fixture.clinikoPaths.filter(path => path.endsWith("/available_times"))
          .map(path => path.includes("/practitioners/22/") ? "old" : "unexpected"), ["old"]);
        await closeCaller(first);

        const target = new URL(process.env.DATABASE_URL!);
        target.pathname = `/${fixture.databaseName}`;
        const db = connectPostgres(target.toString());
        try {
          const store = new PostgresClinikoApprovalStore(db);
          const current = await store.read({ tenantId: "fault-test", clinicId: "clinic", locationId: "main" });
          assert.ok(current.ok && current.value.approval);
          assert.ok((await store.change(current.value.approval.scope, current.value.version,
            { ...current.value.approval, selection: { ...current.value.approval.selection,
              practitionerId: "44", appointmentTypeId: "55" } }, "synthetic-admin")).ok);
        } finally { await db.destroy(); }

        const secondCallSid = `CA${randomUUID().replaceAll("-", "")}`;
        const second = await fixture.openCall(secondCallSid);
        await markGreeting(second);
        second.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: second.streamSid,
          dtmf: { track: "inbound_track", digit: "2" } }));
        await waitFor(() => second.messages.length >= 4 && fixture.speech.length >= 4, "new primary response");
        assert.match(fixture.speech[3]!, /possible times/);
        assert.match(fixture.speech[3]!, /can't reserve or confirm/);
        assert.deepEqual(fixture.clinikoPaths.filter(path => path.endsWith("/available_times"))
          .map(path => path.includes("/practitioners/44/") ? "new" : "old"), ["old", "new"]);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        await closeCaller(second);
        const privacyDb = connectPostgres(target.toString());
        try {
          assert.deepEqual(await scanPatientDataCanaries(privacyDb,
            [{ label: "new_provider_call", value: secondCallSid }]), { ok: true, value: [] });
        } finally { await privacyDb.destroy(); }
        assert.deepEqual(await scanDisposableBackupCanaries(target.toString(),
          [{ label: "new_provider_call", value: secondCallSid }]), []);
      })),
    t.test("E2E-176 database loss closes active stream and health fails", async () => withFixture(undefined, async fixture => {
      const call = await fixture.openCall();
      await markGreeting(call);
      await sql.raw(`alter database "${fixture.databaseName}" with allow_connections false`).execute(fixture.admin);
      await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${fixture.databaseName}`.execute(fixture.admin);
      assert.equal((await bounded(call.closed, "database loss close"))[0], 1011,
        `runner exit=${fixture.child.exitCode ?? "running"}, signal=${fixture.child.signalCode ?? "none"}`);
      let health: Response;
      try {
        health = await fetch(`http://127.0.0.1:${fixture.port}/healthz`,
          { signal: AbortSignal.timeout(5_000) });
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error
          ? error.cause as Error & { code?: string } : undefined;
        throw new Error(`database-loss health request failed: runner exit=${fixture.child.exitCode ?? "running"}, ` +
          `signal=${fixture.child.signalCode ?? "none"}, cause=${cause?.code ?? cause?.name ?? "unknown"}`);
      }
      assert.equal(health.status, 503);
    })),
    t.test("E2E-234 caller hangup aborts an in-flight Cliniko read before its deadline", async () =>
      withFixture("cliniko-slow-read", async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "1" } }));
        await waitFor(() => fixture.clinikoPaths.some(path => path.endsWith("/available_times")),
          "in-flight availability read");
        const disconnectedAt = Date.now();
        await closeCaller(call);
        await waitFor(() => fixture.clinikoReadAborts.length === 1, "call-scoped read abort");
        assert.equal(fixture.clinikoReadAborts[0]!.reason, "AbortError");
        assert.ok(fixture.clinikoReadAborts[0]!.at - disconnectedAt < 8_000);
        let ended = false;
        const until = Date.now() + 8_000;
        while (!ended && Date.now() < until) {
          ended = (await fixture.operationalSnapshot()).callEnded === 1;
          if (!ended) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(ended, true, "call owner must finish after the aborted read");
        assert.deepEqual(call.messages.map(item => item.event), ["media", "mark"]);
        assert.equal(fixture.speech.length, 1);
        assert.ok(fixture.clinikoMethods.every(method => method === "GET"));
        const health = await fetch(`http://127.0.0.1:${fixture.port}/healthz`);
        assert.equal(health.status, 200);
      })),
    t.test("E2E-177 E2E-197 abrupt exit drops the stream and refuses the next ingress", async () => withFixture(undefined, async fixture => {
      const call = await fixture.openCall();
      await markGreeting(call);
      const exited = once(fixture.child, "exit");
      fixture.child.kill("SIGKILL");
      const [code, signal] = await bounded(exited, "abrupt runner exit");
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      assert.equal((await bounded(call.closed, "abrupt stream close"))[0], 1006);
      await assert.rejects(fetch(`http://127.0.0.1:${fixture.port}/healthz`, { signal: AbortSignal.timeout(1_000) }));
      const nextForm = { AccountSid: accountSid, CallSid: `CA${randomUUID().replaceAll("-", "")}`, To: number, From: caller };
      await assert.rejects(fetch(`http://127.0.0.1:${fixture.port}/twilio/inbound`, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, nextForm) },
        body: new URLSearchParams(nextForm), signal: AbortSignal.timeout(1_000) }));
      const rejected = new WebSocket(`ws://127.0.0.1:${fixture.port}/twilio/media/`, { headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
      } });
      await assert.rejects(bounded(once(rejected, "open"), "runner-down socket refusal"));
    })),
    t.test("E2E-213 a fresh runner accepts a new signed call after abrupt process loss", async () => withFixture(undefined, async fixture => {
      const first = await fixture.openCall();
      await markGreeting(first);
      const exited = once(fixture.child, "exit");
      fixture.child.kill("SIGKILL");
      assert.deepEqual(await bounded(exited, "first runner exit"), [null, "SIGKILL"]);
      assert.equal((await bounded(first.closed, "first stream loss"))[0], 1006);

      const priorSpeech = fixture.speech.length;
      await fixture.restart();
      const second = await fixture.openCall(`CA${randomUUID().replaceAll("-", "")}`);
      await markGreeting(second);
      assert.match(fixture.speech[priorSpeech] ?? "", /Press 1 for possible times today/);
      second.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: second.streamSid,
        dtmf: { track: "inbound_track", digit: "2" } }));
      await waitFor(() => second.messages.length >= 4 && fixture.speech.length >= priorSpeech + 2,
        "availability after restart");
      assert.match(fixture.speech[priorSpeech + 1]!, /possible times/);
      assert.match(fixture.speech[priorSpeech + 1]!, /can't reserve or confirm/);
      assert.ok(fixture.clinikoMethods.length > 0 && fixture.clinikoMethods.every(method => method === "GET"));
      await closeCaller(second);
    })),
  ]);
});
