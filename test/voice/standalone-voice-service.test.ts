import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresClinikoApprovalStore } from "../../src/storage/postgres-cliniko-approval-store.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { seedSyntheticCatalogueApproval } from "../support/seed-synthetic-catalogue-approval.ts";

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

async function healthy(port: number): Promise<Response> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { return await fetch(`http://127.0.0.1:${port}/healthz`); }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error("local voice service did not start");
}

test("E2E-171 local voice runner validates startup, reports unready, refuses inbound calls and drains",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_voice_service_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  const port = await freePort();
  const env = { ...process.env,
    ABBY_VOICE_TEST_MODE: undefined, ABBY_TWILIO_TEST_CALLER_NUMBER: undefined,
    ABBY_VOICE_OPERATIONS_TOKEN_HEX: undefined,
    DATABASE_URL: target.toString(), ABBY_VOICE_PORT: String(port),
    ABBY_TENANT_ID: "local-test", ABBY_CLINIC_ID: "clinic", ABBY_LOCATION_ID: "main",
    ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com",
    ABBY_CLINIKO_BUSINESS_ID: undefined, ABBY_CLINIKO_PRACTITIONER_ID: undefined,
    ABBY_CLINIKO_APPOINTMENT_TYPE_ID: undefined, ABBY_CLINIKO_TIME_ZONE: undefined,
    ABBY_TWILIO_TEST_NUMBER: "+6125550199", ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
    ABBY_TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, ABBY_TWILIO_AUTH_TOKEN: "synthetic-token",
    ABBY_TWILIO_PUBLIC_WEBHOOK_URL: "https://calls.example.test/twilio/inbound",
    ABBY_TWILIO_PUBLIC_STREAM_URL: "wss://calls.example.test/twilio/media/",
    ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32), ABBY_VOICE_ROUTE_VERSION: "test-v1",
    ABBY_GREETING_VERSION: "test-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-approval",
    ABBY_GREETING_APPROVED_TEXT: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow.",
    ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0",
    ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
  } satisfies NodeJS.ProcessEnv;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    const db = connectPostgres(target.toString());
    try { await migrate(db); } finally { await db.destroy(); }
    const invalid = spawn(process.execPath, ["scripts/serve-cliniko-voice.ts"], {
      cwd: new URL("../../", import.meta.url), env: { ...env, ABBY_TWILIO_BINDING_KEY_HEX: "bad" },
      stdio: ["ignore", "pipe", "pipe"] });
    const [invalidCode] = await once(invalid, "exit");
    assert.equal(invalidCode, 1);
    const invalidMode = spawn(process.execPath, ["scripts/serve-cliniko-voice.ts"], {
      cwd: new URL("../../", import.meta.url), env: { ...env, ABBY_VOICE_TEST_MODE: "yes" },
      stdio: ["ignore", "pipe", "pipe"] });
    assert.equal((await once(invalidMode, "exit"))[0], 1);
    const invalidOperationalToken = spawn(process.execPath, ["scripts/serve-cliniko-voice.ts"], {
      cwd: new URL("../../", import.meta.url), env: { ...env, ABBY_VOICE_OPERATIONS_TOKEN_HEX: "short" },
      stdio: ["ignore", "pipe", "pipe"] });
    assert.equal((await once(invalidOperationalToken, "exit"))[0], 1);
    const invalidWeekMode = spawn(process.execPath, ["scripts/serve-cliniko-voice.ts"], {
      cwd: new URL("../../", import.meta.url), env: { ...env, ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "yes" },
      stdio: ["ignore", "pipe", "pipe"] });
    assert.equal((await once(invalidWeekMode, "exit"))[0], 1);
    const missingWeekInstruction = spawn(process.execPath, ["scripts/serve-cliniko-voice.ts"], {
      cwd: new URL("../../", import.meta.url), env: { ...env, ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"] });
    assert.equal((await once(missingWeekInstruction, "exit"))[0], 1);
    const disabledWeekInstruction = spawn(process.execPath, ["scripts/serve-cliniko-voice.ts"], {
      cwd: new URL("../../", import.meta.url), env: { ...env,
        ABBY_GREETING_APPROVED_TEXT: `${env.ABBY_GREETING_APPROVED_TEXT} Press 3 for possible times over the next week.` },
      stdio: ["ignore", "pipe", "pipe"] });
    assert.equal((await once(disabledWeekInstruction, "exit"))[0], 1);
    child = spawn(process.execPath, ["scripts/serve-cliniko-voice.ts"], {
      cwd: new URL("../../", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
    const health = await healthy(port);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(readiness.status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/operations`)).status, 404);
    const unsigned = await fetch(`http://127.0.0.1:${port}/twilio/inbound`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ AccountSid: env.ABBY_TWILIO_ACCOUNT_SID,
        CallSid: `CA${"2".repeat(32)}`, To: env.ABBY_TWILIO_TEST_NUMBER,
        From: "+6145550101" }),
    });
    assert.equal(unsigned.status, 403);
    const form = { AccountSid: env.ABBY_TWILIO_ACCOUNT_SID, CallSid: `CA${"2".repeat(32)}`,
      To: env.ABBY_TWILIO_TEST_NUMBER, From: "+6145550101" };
    const signed = await fetch(`http://127.0.0.1:${port}/twilio/inbound`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(env.ABBY_TWILIO_AUTH_TOKEN,
          env.ABBY_TWILIO_PUBLIC_WEBHOOK_URL, form) },
      body: new URLSearchParams(form),
    });
    assert.equal(signed.status, 503);
    assert.doesNotMatch(await signed.text(), /<Stream>/);
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = await exit;
    assert.equal(code, 0);
    child = undefined;
  } finally {
    child?.kill("SIGKILL");
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});

test("E2E-172 E2E-185 E2E-209 isolated voice runner enforces durable approval around signed keypad calls and shutdown",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_test_voice_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const port = await freePort();
  const number = "+6125550199";
  const callerNumber = "+6145550101";
  const accountSid = `AC${"1".repeat(32)}`;
  const authToken = "synthetic-token";
  const operationalTokenHex = "a".repeat(64);
  const webhookUrl = "https://calls.example.test/twilio/inbound";
  const streamUrl = "wss://calls.example.test/twilio/media/";
  const scope = { tenantId: "local-test", clinicId: "clinic", locationId: "main" };
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: target.toString(),
    ABBY_ISOLATED_POSTGRES_PROBE: "1", ABBY_VOICE_PORT: String(port), ABBY_VOICE_TEST_MODE: "1",
    ABBY_TWILIO_TEST_CALLER_NUMBER: callerNumber,
    ABBY_TENANT_ID: scope.tenantId, ABBY_CLINIC_ID: scope.clinicId, ABBY_LOCATION_ID: scope.locationId,
    ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com",
    ABBY_CLINIKO_BUSINESS_ID: undefined, ABBY_CLINIKO_PRACTITIONER_ID: undefined,
    ABBY_CLINIKO_APPOINTMENT_TYPE_ID: undefined, ABBY_CLINIKO_TIME_ZONE: undefined,
    ABBY_TWILIO_TEST_NUMBER: number, ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
    ABBY_TWILIO_ACCOUNT_SID: accountSid, ABBY_TWILIO_AUTH_TOKEN: authToken,
    ABBY_VOICE_OPERATIONS_TOKEN_HEX: operationalTokenHex,
    ABBY_TWILIO_PUBLIC_WEBHOOK_URL: webhookUrl, ABBY_TWILIO_PUBLIC_STREAM_URL: streamUrl,
    ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32), ABBY_VOICE_ROUTE_VERSION: "test-v1",
    ABBY_TEST_OPERATOR_REF: "synthetic-operator", ABBY_AUTOMATION_EXPECTED_VERSION: "0",
    ABBY_GREETING_VERSION: "test-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-approval",
    ABBY_GREETING_APPROVED_TEXT: "This is an Abby test call. Press 1 for possible times today. Press 2 for possible times tomorrow.",
    ABBY_SEVEN_DAY_AVAILABILITY_ENABLED: "0",
    ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
  };
  let created = false;
  let child: ReturnType<typeof spawn> | undefined;
  let caller: WebSocket | undefined;
  const clinikoMethods: string[] = [];
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    const db = connectPostgres(target.toString());
    try { await migrate(db); } finally { await db.destroy(); }
    const enable = spawnSync(process.execPath, ["scripts/set-voice-test-automation.ts", "enable"], {
      cwd: new URL("../../", import.meta.url), env, encoding: "utf8",
    });
    assert.equal(enable.status, 0, enable.stderr);
    child = spawn(process.execPath, ["test/support/start-synthetic-voice-runner.ts"], {
      cwd: new URL("../../", import.meta.url), env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.on("message", message => {
      if (typeof message === "object" && message !== null && "kind" in message &&
          message.kind === "clinikoMethod" && "method" in message && typeof message.method === "string") {
        clinikoMethods.push(message.method);
      }
    });
    assert.equal((await healthy(port)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 503);
    const operationalUrl = `http://127.0.0.1:${port}/internal/operations`;
    assert.equal((await fetch(operationalUrl)).status, 403);
    assert.equal((await fetch(operationalUrl, { headers: { authorization: `Bearer ${"b".repeat(64)}` } })).status, 403);
    assert.equal((await fetch(operationalUrl, { method: "POST", headers: {
      authorization: `Bearer ${operationalTokenHex}` } })).status, 403);

    async function webhook(from: string, callSid: string, signed = true): Promise<Response> {
      const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: from };
      return fetch(`http://127.0.0.1:${port}/twilio/inbound`, { method: "POST", headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(signed ? { "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form) } : {}),
      }, body: new URLSearchParams(form) });
    }
    const callSid = `CA${"2".repeat(32)}`;
    assert.equal((await webhook(callerNumber, callSid, false)).status, 403);
    const rejected = await webhook("+6145550102", callSid);
    assert.equal(rejected.status, 503);
    assert.doesNotMatch(await rejected.text(), /<Stream>/);
    const unapproved = await webhook(callerNumber, callSid);
    assert.equal(unapproved.status, 503);
    assert.doesNotMatch(await unapproved.text(), /<Stream>/);
    assert.deepEqual(clinikoMethods, []);
    const approvalDb = connectPostgres(target.toString());
    try {
      await seedSyntheticCatalogueApproval(approvalDb, { scope, accountRef: accountSid,
        dialedNumber: number, routeVersion: "test-v1", apiKey: "synthetic-key-au5" });
      const store = new PostgresClinikoApprovalStore(approvalDb);
      const saved = await store.read(scope);
      assert.ok(saved.ok && saved.value.approval);
      assert.ok((await store.change(scope, 1, { ...saved.value.approval,
        selection: { ...saved.value.approval.selection, businessId: "999" } }, "synthetic-admin")).ok);
    }
    finally { await approvalDb.destroy(); }
    const wrongSelection = await webhook(callerNumber, `CA${"8".repeat(32)}`);
    assert.equal(wrongSelection.status, 200);
    assert.match(await wrongSelection.text(), /<Stream/);
    assert.deepEqual(clinikoMethods, []);
    const correctedDb = connectPostgres(target.toString());
    try {
      const store = new PostgresClinikoApprovalStore(correctedDb);
      const saved = await store.read(scope);
      assert.ok(saved.ok && saved.value.approval);
      assert.ok((await store.change(scope, 2, { ...saved.value.approval,
        selection: { ...saved.value.approval.selection, businessId: "11" },
        businessTimeZone: "Etc/UTC" }, "synthetic-admin")).ok);
    } finally { await correctedDb.destroy(); }
    const wrongZone = await webhook(callerNumber, `CA${"7".repeat(32)}`);
    assert.equal(wrongZone.status, 200);
    assert.match(await wrongZone.text(), /<Stream/);
    assert.deepEqual(clinikoMethods, []);
    const zoneDb = connectPostgres(target.toString());
    try {
      const store = new PostgresClinikoApprovalStore(zoneDb);
      const saved = await store.read(scope);
      assert.ok(saved.ok && saved.value.approval);
      assert.ok((await store.change(scope, 3, { ...saved.value.approval,
        businessTimeZone: "Australia/Sydney" }, "synthetic-admin")).ok);
    } finally { await zoneDb.destroy(); }
    const accepted = await webhook(callerNumber, callSid);
    assert.equal(accepted.status, 200);
    const xml = await accepted.text();
    assert.ok(xml.endsWith("</Connect><Dial>+6125550188</Dial></Response>"));
    const binding = xml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);

    const forged = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await once(forged, "open");
    const forgedClosed = once(forged, "close");
    forged.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    forged.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: `MZ${"4".repeat(32)}`,
      start: { accountSid, callSid, streamSid: `MZ${"4".repeat(32)}`,
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: `${binding.startsWith("A") ? "B" : "A"}${binding.slice(1)}` } } }));
    assert.equal((await forgedClosed)[0], 1008);

    caller = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await once(caller, "open");
    const received: Record<string, unknown>[] = [];
    const waitFor = (count: number) => new Promise<void>((resolve, reject) => {
      if (received.length >= count) { resolve(); return; }
      const timer = setTimeout(() => { caller?.off("message", onMessage); reject(new Error("voice output timed out")); }, 8_000);
      const onMessage = () => {
        if (received.length >= count) { clearTimeout(timer); caller?.off("message", onMessage); resolve(); }
      };
      caller!.on("message", onMessage);
    });
    caller.on("message", data => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
    const streamSid = `MZ${"3".repeat(32)}`;
    caller.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    caller.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await waitFor(2);
    assert.deepEqual(received.slice(0, 2).map(item => item.event), ["media", "mark"]);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: (received[1]!.mark as { name: string }).name } }));
    caller.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid,
      dtmf: { track: "inbound_track", digit: "1" } }));
    await waitFor(4);
    assert.deepEqual(received.slice(2, 4).map(item => item.event), ["media", "mark"]);
    for (let index = 0; index < 2; index += 1) caller.send(JSON.stringify({ event: "media",
      sequenceNumber: String(index + 4), streamSid, media: { track: "inbound", chunk: String(index + 1),
        timestamp: String(index * 20), payload: Buffer.alloc(160, 0x9f).toString("base64") } }));
    await waitFor(6);
    assert.deepEqual(received.slice(4, 6).map(item => item.event), ["mark", "clear"]);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "6", streamSid,
      mark: { name: (received[3]!.mark as { name: string }).name } }));
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "7", streamSid,
      mark: { name: (received[4]!.mark as { name: string }).name } }));
    assert.equal(caller.readyState, WebSocket.OPEN);
    const revocationDb = connectPostgres(target.toString());
    try {
      const store = new PostgresClinikoApprovalStore(revocationDb);
      assert.ok((await store.change(scope, 4, null, "synthetic-admin")).ok);
    } finally { await revocationDb.destroy(); }
    const revoked = await webhook(callerNumber, `CA${"9".repeat(32)}`);
    assert.equal(revoked.status, 503);
    assert.doesNotMatch(await revoked.text(), /<Stream>/);
    const operationalResponse = await fetch(operationalUrl, { headers: {
      authorization: `Bearer ${operationalTokenHex}` } });
    assert.equal(operationalResponse.status, 200);
    assert.equal(operationalResponse.headers.get("cache-control"), "no-store");
    const counts = await operationalResponse.json() as Record<string, number>;
    assert.deepEqual(Object.keys(counts).sort(),
      ["admissionDenied", "callOwnerStarted", "voiceFailure", "callEnded",
        "clinikoBudgetDenied", "clinikoBudgetUnavailable", "clinikoProvider429",
        "clinikoProviderUnavailable"].sort());
    assert.ok(counts.admissionDenied! >= 3);
    assert.equal(counts.callOwnerStarted, 1);
    assert.equal(counts.voiceFailure, 0);
    assert.equal(JSON.stringify(counts).includes(callerNumber), false);
    assert.equal(JSON.stringify(counts).includes(callSid), false);
    const operatorRead = spawnSync(process.execPath, ["scripts/read-voice-operations.ts"], {
      cwd: new URL("../../", import.meta.url), env, encoding: "utf8", timeout: 10_000 });
    assert.equal(operatorRead.status, 0, operatorRead.stderr);
    assert.deepEqual(JSON.parse(operatorRead.stdout), counts);
    assert.equal(operatorRead.stdout.includes(callerNumber) || operatorRead.stdout.includes(callSid), false);
    const closed = once(caller, "close");
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    await closed;
    assert.equal(code, 0);
    child = undefined;
    const privateDb = connectPostgres(target.toString());
    try {
      assert.deepEqual(await scanPatientDataCanaries(privateDb, [
        { label: "caller", value: callerNumber }, { label: "provider_call", value: callSid },
        { label: "appointment", value: "synthetic-only" },
      ]), { ok: true, value: [] });
    } finally { await privateDb.destroy(); }
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [
      { label: "caller", value: callerNumber }, { label: "provider_call", value: callSid },
      { label: "appointment", value: "synthetic-only" },
    ]), []);
    const disable = spawnSync(process.execPath, ["scripts/set-voice-test-automation.ts", "disable"], {
      cwd: new URL("../../", import.meta.url), env: { ...env, ABBY_AUTOMATION_EXPECTED_VERSION: "1" },
      encoding: "utf8",
    });
    assert.equal(disable.status, 0, disable.stderr);
  } finally {
    caller?.terminate();
    child?.kill("SIGKILL");
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
