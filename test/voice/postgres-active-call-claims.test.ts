import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ok } from "../../src/core/model.ts";
import { createStandaloneClinikoVoiceServer } from "../../src/standalone/cliniko-voice-server.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresActiveCallClaims } from "../../src/storage/postgres-active-call-claims.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { syntheticCatalogueApproval } from "../support/synthetic-catalogue-approval.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

test("E2E-170 two signed servers share active call ownership and close on PostgreSQL session loss",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 20_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_active_call_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const accountSid = `AC${"1".repeat(32)}`;
  const callSid = `CA${"2".repeat(32)}`;
  const streamSid = `MZ${"3".repeat(32)}`;
  const callerPhone = "+6145550101";
  const dialedNumber = "+6125550199";
  const authToken = "synthetic-active-call-token";
  const webhookUrl = "https://calls.example.test/twilio/inbound";
  const streamUrl = "wss://calls.example.test/twilio/media/";
  const bindingKey = Buffer.alloc(32, 0x66);
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let serverA: Server | undefined;
  let serverB: Server | undefined;
  let socketA: WebSocket | undefined;
  let socketB: WebSocket | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    assert.equal(await new PostgresActiveCallClaims(target.toString(), bindingKey).matchesDatabase(db), true);
    assert.equal(await new PostgresActiveCallClaims(adminUrl, bindingKey).matchesDatabase(db), false);
    const scope = { tenantId: "ownership", clinicId: "clinic", locationId: "main" };
    const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-key-au5" });
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5", rateBudget,
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async () => { throw new Error("startup must not call Cliniko"); });
    assert.ok(availability.ok);
    await assert.rejects(createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(adminUrl, bindingKey),
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        fallbackNumbers: { [dialedNumber]: "+6125550188" }, bindingKey },
      routes: [{ dialedNumber, scope, routeVersion: "v1", availability: availability.value, rateBudget,
        approval: syntheticCatalogueApproval(availability.value, scope, { accountRef: accountSid,
          dialedNumber, routeVersion: "v1" }),
        timeZone: "Australia/Sydney", clinicDate: () => "2026-09-29", keypadAvailabilityGreeting: { scope, version: "test-keypad-v1",
          ownerRef: "synthetic-approval", approved: true,
          approvedText: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow." } }],
      openai: { apiKey: "synthetic-openai-key", intentModel: "synthetic-model" },
      readiness: async () => ok(true),
    }), /active-call ownership database mismatch/);
    const ingress = () => new TwilioSignedIngress({ accountSid, authToken,
      publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
      fallbackNumbers: { [dialedNumber]: "+6125550188" }, bindingKey,
      now: () => new Date("2026-09-29T10:00:00.000Z") });
    let ownersA = 0;
    let ownersB = 0;
    let released!: () => void;
    const ownerReleased = new Promise<void>(resolve => { released = resolve; });
    serverA = createTwilioIngressServer({ ingress: ingress(),
      activeCallClaims: new PostgresActiveCallClaims(target.toString(), bindingKey),
      async createCall(_stream, send) {
        ownersA += 1;
        return { async receive(raw) {
          if (JSON.parse(raw).event === "start") send(JSON.stringify({ event: "ready" }));
          return { ok: true };
        }, async disconnect() { released(); } };
      } });
    serverB = createTwilioIngressServer({ ingress: ingress(),
      activeCallClaims: new PostgresActiveCallClaims(target.toString(), bindingKey),
      async createCall() {
        ownersB += 1;
        throw new Error("duplicate must not construct a call owner");
      } });
    serverA.listen(0, "127.0.0.1");
    serverB.listen(0, "127.0.0.1");
    await Promise.all([once(serverA, "listening"), once(serverB, "listening")]);
    const addressA = serverA.address();
    const addressB = serverB.address();
    assert.ok(addressA && typeof addressA !== "string" && addressB && typeof addressB !== "string");
    const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: callerPhone };
    const webhook = await fetch(`http://127.0.0.1:${addressA.port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(webhook.status, 200);
    const binding = (await webhook.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    const signature = twilio.getExpectedTwilioSignature(authToken, streamUrl, {});
    const open = async (port: number): Promise<WebSocket> => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, {
        headers: { "x-twilio-signature": signature } });
      await once(socket, "open");
      return socket;
    };
    const start = (socket: WebSocket): void => {
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
        start: { accountSid, callSid, streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
    };
    socketA = await open(addressA.port);
    const ready = once(socketA, "message");
    start(socketA);
    assert.deepEqual(JSON.parse((await ready)[0].toString()), { event: "ready" });
    socketB = await open(addressB.port);
    const duplicateClosed = once(socketB, "close");
    start(socketB);
    assert.equal((await duplicateClosed)[0], 1008);
    assert.equal(ownersA, 1);
    assert.equal(ownersB, 0);
    assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "caller", value: callerPhone },
      { label: "provider_call", value: callSid }]), { ok: true, value: [] });

    const closed = once(socketA, "close");
    const killed = await sql<{ killed: boolean }>`select pg_terminate_backend(pid) as killed
      from pg_stat_activity where datname = current_database()
        and application_name = 'abby-active-call-claims'`.execute(db);
    assert.deepEqual(killed.rows.map(row => row.killed), [true]);
    assert.equal((await closed)[0], 1011);
    await ownerReleased;
  } finally {
    socketA?.terminate();
    socketB?.terminate();
    if (serverA) { serverA.close(); await once(serverA, "close"); }
    if (serverB) { serverB.close(); await once(serverB, "close"); }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
