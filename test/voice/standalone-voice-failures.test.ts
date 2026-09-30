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

type Fault = "openai-speech" | "cliniko-rate-limit" | "cliniko-timeout" | "cliniko-partial-page" |
  "cliniko-business-type-removed" | undefined;
const fallbackScenarios = [
  { fault: "cliniko-rate-limit", id: "E2E-174" },
  { fault: "cliniko-timeout", id: "E2E-175" },
  { fault: "cliniko-partial-page", id: "E2E-190" },
  { fault: "cliniko-business-type-removed", id: "E2E-193" },
] as const;
const number = "+6125550199";
const caller = "+6145550101";
const accountSid = `AC${"1".repeat(32)}`;
const authToken = "synthetic-token";
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";
const noStaffNotice = "I can't send a staff request from this call. Please contact the clinic directly.";
const root = new URL("../../", import.meta.url);

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 8_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const until = Date.now() + 8_000;
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
  speech: string[]; clinikoMethods: string[]; clinikoPaths: string[]; openCall: () => Promise<Call> };

async function withFixture(fault: Fault, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const databaseName = `abby_test_voice_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const port = await freePort();
  const callSid = `CA${randomUUID().replaceAll("-", "")}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
    DATABASE_URL: target.toString(), ABBY_ISOLATED_POSTGRES_PROBE: "1",
    ABBY_VOICE_PORT: String(port), ABBY_VOICE_TEST_MODE: "1",
    ABBY_SYNTHETIC_VOICE_FAULT: fault, ABBY_TWILIO_TEST_CALLER_NUMBER: caller,
    ABBY_TENANT_ID: "fault-test", ABBY_CLINIC_ID: "clinic", ABBY_LOCATION_ID: "main",
    ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com",
    ABBY_CLINIKO_BUSINESS_ID: "11", ABBY_CLINIKO_PRACTITIONER_ID: "22",
    ABBY_CLINIKO_APPOINTMENT_TYPE_ID: "33", ABBY_CLINIKO_TIME_ZONE: "Australia/Sydney",
    ABBY_TWILIO_TEST_NUMBER: number, ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
    ABBY_TWILIO_ACCOUNT_SID: accountSid, ABBY_TWILIO_AUTH_TOKEN: authToken,
    ABBY_TWILIO_PUBLIC_WEBHOOK_URL: webhookUrl, ABBY_TWILIO_PUBLIC_STREAM_URL: streamUrl,
    ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32), ABBY_VOICE_ROUTE_VERSION: "fault-test-v1",
    ABBY_TEST_OPERATOR_REF: "synthetic-operator", ABBY_AUTOMATION_EXPECTED_VERSION: "0",
    ABBY_GREETING_VERSION: "fault-test-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-approval",
    ABBY_GREETING_APPROVED_TEXT: "This is an Abby test call. Press 1 for possible times today. Press 2 for possible times tomorrow.",
    ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
  };
  let created = false;
  let child: ReturnType<typeof spawn> | undefined;
  let socket: WebSocket | undefined;
  const speech: string[] = [];
  const clinikoMethods: string[] = [];
  const clinikoPaths: string[] = [];
  let processOutput = "";
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin);
    created = true;
    const db = connectPostgres(target.toString());
    try {
      await migrate(db);
      await seedSyntheticCatalogueApproval(db, { scope: { tenantId: "fault-test", clinicId: "clinic", locationId: "main" },
        accountRef: accountSid, dialedNumber: number, routeVersion: "fault-test-v1",
        apiKey: "synthetic-key-au5" });
    } finally { await db.destroy(); }
    const enabled = spawnSync(process.execPath, ["scripts/set-voice-test-automation.ts", "enable"],
      { cwd: root, env, encoding: "utf8", timeout: 15_000 });
    assert.equal(enabled.status, 0, enabled.stderr);
    child = spawn(process.execPath, ["test/support/start-synthetic-voice-runner.ts"],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.on("message", message => {
      if (typeof message === "object" && message !== null && "kind" in message &&
          message.kind === "speech" && "text" in message && typeof message.text === "string") speech.push(message.text);
      if (typeof message === "object" && message !== null && "kind" in message &&
          message.kind === "clinikoMethod" && "method" in message && typeof message.method === "string") {
        clinikoMethods.push(message.method);
        if ("path" in message && typeof message.path === "string") clinikoPaths.push(message.path);
      }
    });
    child.stdout?.on("data", data => { processOutput += String(data); });
    child.stderr?.on("data", data => { processOutput += String(data); });
    const healthUrl = `http://127.0.0.1:${port}/healthz`;
    const until = Date.now() + 15_000;
    let healthy = false;
    while (!healthy && Date.now() < until) {
      try { healthy = (await fetch(healthUrl, { signal: AbortSignal.timeout(500) })).status === 200; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(healthy, "voice runner did not start");
    const openCall = async (): Promise<Call> => {
      const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: caller };
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
        start: { accountSid, callSid, streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
      return { socket, messages, closed, streamSid };
    };
    await run({ port, child, admin, databaseName, speech, clinikoMethods, clinikoPaths, openCall });
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
          { label: "caller", value: caller }, { label: "provider_call", value: callSid },
          { label: "appointment", value: "synthetic-only" },
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

async function closeCaller(call: Call): Promise<void> {
  call.socket.close(1000);
  assert.equal((await bounded(call.closed, "caller close"))[0], 1000);
}

test("isolated signed runner failure paths", { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1",
  timeout: 90_000, concurrency: 5 }, async t => {
  await Promise.all([
    ...fallbackScenarios.map(({ fault, id }) =>
      t.test(`${id} safe spoken fallback on ${fault}`,
        async () => withFixture(fault, async fixture => {
        const call = await fixture.openCall();
        await markGreeting(call);
        call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
          dtmf: { track: "inbound_track", digit: "1" } }));
        await waitFor(() => call.messages.length >= 4 && fixture.speech.length >= 2, "safe availability response");
        assert.deepEqual(call.messages.slice(2, 4).map(item => item.event), ["media", "mark"]);
        assert.equal(fixture.speech[1], noStaffNotice);
        assert.ok(!fixture.speech.some(text => text.includes("10:00") || text.includes("synthetic-only")));
        assert.ok(fixture.clinikoMethods.length > 0 && fixture.clinikoMethods.every(method => method === "GET"));
        if (fault === "cliniko-partial-page") {
          assert.equal(fixture.clinikoPaths.filter(path => path.endsWith("/available_times")).length, 1);
        }
        if (fault === "cliniko-business-type-removed") {
          assert.deepEqual(fixture.clinikoPaths, ["/v1/businesses/11"]);
        }
        await closeCaller(call);
      }))),
    t.test("E2E-173 OpenAI greeting failure closes before audio", async () => withFixture("openai-speech", async fixture => {
      const call = await fixture.openCall();
      assert.equal((await bounded(call.closed, "speech failure close"))[0], 1008);
      assert.deepEqual(call.messages, []);
      assert.equal(fixture.speech.length, 1);
    })),
    t.test("E2E-176 database loss closes active stream and health fails", async () => withFixture(undefined, async fixture => {
      const call = await fixture.openCall();
      await markGreeting(call);
      await sql.raw(`alter database "${fixture.databaseName}" with allow_connections false`).execute(fixture.admin);
      await sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = ${fixture.databaseName}`.execute(fixture.admin);
      assert.equal((await bounded(call.closed, "database loss close"))[0], 1011);
      assert.equal((await fetch(`http://127.0.0.1:${fixture.port}/healthz`)).status, 503);
    })),
    t.test("E2E-177 abrupt exit drops stream without a fallback claim", async () => withFixture(undefined, async fixture => {
      const call = await fixture.openCall();
      await markGreeting(call);
      const exited = once(fixture.child, "exit");
      fixture.child.kill("SIGKILL");
      const [code, signal] = await bounded(exited, "abrupt runner exit");
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      assert.equal((await bounded(call.closed, "abrupt stream close"))[0], 1006);
      await assert.rejects(fetch(`http://127.0.0.1:${fixture.port}/healthz`, { signal: AbortSignal.timeout(1_000) }));
    })),
  ]);
});
