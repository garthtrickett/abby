import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";

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
    DATABASE_URL: target.toString(), ABBY_VOICE_PORT: String(port),
    ABBY_TENANT_ID: "local-test", ABBY_CLINIC_ID: "clinic", ABBY_LOCATION_ID: "main",
    ABBY_CLINIKO_API_KEY: "synthetic-key-au5", ABBY_CLINIKO_CONTACT_EMAIL: "test@example.com",
    ABBY_CLINIKO_BUSINESS_ID: "11", ABBY_CLINIKO_PRACTITIONER_ID: "22",
    ABBY_CLINIKO_APPOINTMENT_TYPE_ID: "33", ABBY_CLINIKO_TIME_ZONE: "Australia/Sydney",
    ABBY_TWILIO_TEST_NUMBER: "+6125550199", ABBY_TWILIO_FALLBACK_NUMBER: "+6125550188",
    ABBY_TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`, ABBY_TWILIO_AUTH_TOKEN: "synthetic-token",
    ABBY_TWILIO_PUBLIC_WEBHOOK_URL: "https://calls.example.test/twilio/inbound",
    ABBY_TWILIO_PUBLIC_STREAM_URL: "wss://calls.example.test/twilio/media/",
    ABBY_TWILIO_BINDING_KEY_HEX: "66".repeat(32), ABBY_VOICE_ROUTE_VERSION: "test-v1",
    ABBY_GREETING_VERSION: "test-v1", ABBY_GREETING_APPROVAL_OWNER_REF: "synthetic-approval",
    ABBY_GREETING_APPROVED_TEXT: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow.",
    ABBY_OPENAI_API_KEY: "synthetic-openai", ABBY_OPENAI_INTENT_MODEL: "synthetic-model",
  };
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
    child = spawn(process.execPath, ["scripts/serve-cliniko-voice.ts"], {
      cwd: new URL("../../", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
    const health = await healthy(port);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(readiness.status, 503);
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
