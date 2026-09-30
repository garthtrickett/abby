import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ok } from "../../src/core/model.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneClinikoVoiceServer } from "../../src/standalone/cliniko-voice-server.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresActiveCallClaims } from "../../src/storage/postgres-active-call-claims.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

class FakeTranscriptionSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  terminateCount = 0;

  send(raw: string): void {
    const event = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(event);
    if (event.type === "input_audio_buffer.commit") this.emit("commit");
  }
  receive(event: object): void { this.emit("message", Buffer.from(JSON.stringify(event))); }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
    this.receive({ type: "session.updated", session: { type: "transcription", audio: { input: {
      format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe" },
      turn_detection: null,
    } } } });
  }
  terminate(): void { this.terminateCount += 1; this.readyState = WebSocket.CLOSED; this.emit("close"); }
  close(): void { this.terminate(); }
}

test("E2E-143 standalone voice server refuses unsafe storage before opening a listener",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 20_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_voice_preflight_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const scope = { tenantId: "voice-preflight", clinicId: "clinic", locationId: "main" };
    const privateText = `private-note-${randomUUID()}`;
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
      values (${scope.tenantId}, ${scope.clinicId}, ${scope.locationId}, 0,
        ${JSON.stringify({ scope, policyVersion: "0", bookingEnabled: false, privateText })}::jsonb)`.execute(db);
    const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-key-au5" });
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5", rateBudget,
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async () => { throw new Error("blocked server must not call Cliniko"); });
    assert.ok(availability.ok);
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(target.toString(), Buffer.alloc(32, 0x51)),
      twilio: { accountSid: `AC${"1".repeat(32)}`, authToken: "synthetic-twilio-token",
        publicWebhookUrl: "https://calls.example.test/twilio/inbound",
        publicStreamUrl: "wss://calls.example.test/twilio/media/",
        fallbackNumbers: { "+6125550199": "+6125550188" }, bindingKey: Buffer.alloc(32, 0x46) },
      routes: [{ dialedNumber: "+6125550199", scope, routeVersion: "v1",
        availability: availability.value, rateBudget, clinicDate: () => "2026-09-29",
        keypadAvailabilityGreeting: { scope, version: "startup-keypad-v1", ownerRef: "synthetic-clinic-approval",
          approved: true, approvedText: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow." } }],
      openai: { apiKey: "synthetic-openai-key", intentModel: "configured-model" },
      readiness: async () => ok(true),
    });
    assert.deepEqual(prepared, { ok: false,
      error: { kind: "unsafeExistingData", areas: ["settings"] } });
    assert.equal(JSON.stringify(prepared).includes(privateText), false);
  } finally {
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});

test("E2E-138, E2E-139, and E2E-140 local standalone server reads keypad availability then clarifies uncertain speech",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 20_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_server_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let server: Server | undefined;
  let caller: WebSocket | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const accountSid = `AC${"1".repeat(32)}`;
    const callSid = `CA${"2".repeat(32)}`;
    const streamSid = `MZ${"3".repeat(32)}`;
    const authToken = "synthetic-twilio-token";
    const number = "+6125550199";
    const callerPhone = "+6145550101";
    const webhookUrl = "https://calls.example.test/twilio/inbound";
    const streamUrl = "wss://calls.example.test/twilio/media/";
    const now = "2026-09-29T10:00:00.000Z";
    const scope = { tenantId: `server-${randomUUID().slice(0, 8)}`, clinicId: "clinic", locationId: "main" };
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable",
      async () => ok(true), false, "standaloneMinimal");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
    const appointmentId = "private-appointment-140";
    const appointmentTime = "2026-09-30T02:00:00.000Z";
    let clinikoReads = 0;
    const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-key-au5" });
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5", rateBudget,
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async input => {
      clinikoReads += 1;
      const url = new URL(String(input));
      if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
        time_zone_identifier: "Australia/Sydney" });
      if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", active: true,
        show_in_online_bookings: true });
      if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
      if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
        practitioners: [{ id: "22" }] });
      if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
        appointment_types: [{ id: "33" }] });
      if (url.pathname.endsWith("/available_times")) {
        assert.equal(url.searchParams.get("from"), "2026-09-30");
        assert.equal(url.searchParams.get("to"), "2026-09-30");
        return Response.json({ total_entries: 1,
          available_times: [{ appointment_start: appointmentTime, appointment_id: appointmentId }] });
      }
      throw new Error("unexpected Cliniko request");
    }, () => now);
    assert.ok(availability.ok);
    const provider = new FakeTranscriptionSocket();
    let modelCalls = 0;
    let synthesisCalls = 0;
    const spoken: string[] = [];
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(target.toString(), Buffer.alloc(32, 0x51)),
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        fallbackNumbers: { [number]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x46),
        now: () => new Date(now) },
      routes: [{ dialedNumber: number, scope, routeVersion: "v1", availability: availability.value, rateBudget,
        clinicDate: () => "2026-09-29", keypadAvailabilityGreeting: { scope, version: "keypad-v1",
          ownerRef: "clinic-approval", approved: true,
          approvedText: "Hello. Press 1 for possible times today. Press 2 for possible times tomorrow." } }],
      openai: { apiKey: "synthetic-openai-key", intentModel: "configured-model",
        transcriptionSocketFactory: () => {
          queueMicrotask(() => provider.open());
          return provider as unknown as WebSocket;
        },
        fetch: (async (url, init) => {
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-openai-key");
          if (String(url).endsWith("/audio/speech")) {
            synthesisCalls += 1;
            spoken.push((JSON.parse(String(init?.body)) as { input: string }).input);
            return new Response(Buffer.alloc(960), { headers: { "content-type": "audio/pcm" } });
          }
          modelCalls += 1;
          throw new Error("uncertain transcript must not reach intent model");
        }) as typeof fetch },
      readiness: async () => ok(true), mediaOptions: { silenceMs: 100 }, now: () => now,
    });
    assert.ok(prepared.ok);
    server = prepared.value;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: callerPhone };
    const webhook = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(webhook.status, 200);
    const xml = await webhook.text();
    assert.ok(xml.endsWith("</Connect><Dial>+6125550188</Dial></Response>"));
    const binding = xml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    caller = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await once(caller, "open");
    const sent: Record<string, unknown>[] = [];
    let clarificationResolve!: () => void;
    const clarification = new Promise<void>(resolve => { clarificationResolve = resolve; });
    let availabilityResolve!: () => void;
    const availabilitySpoken = new Promise<void>(resolve => { availabilityResolve = resolve; });
    const greeting = new Promise<void>(resolve => caller!.on("message", data => {
      sent.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (sent.length === 2) resolve();
      if (sent.length === 4) availabilityResolve();
      if (sent.length === 6) clarificationResolve();
    }));
    caller.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    caller.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await greeting;
    assert.deepEqual(sent.map(item => item.event), ["media", "mark"]);
    assert.equal(synthesisCalls, 1);
    caller.send(JSON.stringify({ event: "dtmf", sequenceNumber: "2", streamSid,
      dtmf: { track: "inbound_track", digit: "2" } }));
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "3", streamSid,
      mark: { name: (sent[1]?.mark as { name: string }).name } }));
    caller.send(JSON.stringify({ event: "dtmf", sequenceNumber: "4", streamSid,
      dtmf: { track: "inbound_track", digit: "9" } }));
    caller.send(JSON.stringify({ event: "dtmf", sequenceNumber: "5", streamSid,
      dtmf: { track: "inbound_track", digit: "2" } }));
    await availabilitySpoken;
    assert.equal(synthesisCalls, 2);
    assert.equal(modelCalls, 0);
    assert.equal(clinikoReads, 6);
    assert.match(spoken[1]!, /possible times/);
    assert.equal(spoken[1]!.includes(appointmentId), false);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "6", streamSid,
      mark: { name: (sent[3]?.mark as { name: string }).name } }));
    const committed = once(provider, "commit");
    const closed = once(caller, "close");
    for (let index = 0; index < 7; index += 1) {
      if (index === 1) caller.send(JSON.stringify({ event: "dtmf", sequenceNumber: "8", streamSid,
        dtmf: { track: "inbound_track", digit: "1" } }));
      caller.send(JSON.stringify({ event: "media",
        sequenceNumber: String(index === 0 ? 7 : index + 8), streamSid,
        media: { track: "inbound", chunk: String(index + 1),
          timestamp: String(index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
    }
    await committed;
    provider.receive({ type: "input_audio_buffer.committed", item_id: "provider-item" });
    provider.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "provider-item",
      transcript: "Do you have availability on October 2?" });
    await clarification;
    assert.equal(synthesisCalls, 3);
    assert.equal(spoken[2], "Could you repeat that for me?");
    assert.equal(clinikoReads, 6);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "15", streamSid,
      mark: { name: (sent[5]?.mark as { name: string }).name } }));
    const repeated = once(provider, "commit");
    for (let index = 0; index < 7; index += 1) caller.send(JSON.stringify({ event: "media",
      sequenceNumber: String(index + 16), streamSid, media: { track: "inbound", chunk: String(index + 8),
        timestamp: String((index + 7) * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
    await repeated;
    provider.receive({ type: "input_audio_buffer.committed", item_id: "provider-item-2" });
    provider.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "provider-item-2",
      transcript: "Do you have availability on October 2?" });
    assert.equal((await closed)[0], 1008);
    assert.equal(modelCalls, 0);
    assert.equal(clinikoReads, 6);
    assert.equal(provider.terminateCount, 1);
    assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "caller", value: callerPhone },
      { label: "provider_call", value: callSid },
      { label: "spoken_text", value: "Do you have availability on October 2?" },
      { label: "appointment", value: appointmentId }, { label: "time", value: appointmentTime }]), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [{ label: "caller", value: callerPhone },
      { label: "provider_call", value: callSid },
      { label: "spoken_text", value: "Do you have availability on October 2?" },
      { label: "appointment", value: appointmentId }, { label: "time", value: appointmentTime }]), []);
  } finally {
    caller?.terminate();
    if (server) { server.close(); await once(server, "close"); }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});

test("E2E-151 signed standalone call switches speech models before the first output chunk",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 20_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_speech_fallback_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let server: Server | undefined;
  let caller: WebSocket | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const accountSid = `AC${"4".repeat(32)}`;
    const callSid = `CA${"5".repeat(32)}`;
    const streamSid = `MZ${"6".repeat(32)}`;
    const number = "+6125550199";
    const callerPhone = "+6145550101";
    const authToken = "synthetic-twilio-fallback-token";
    const webhookUrl = "https://calls.example.test/twilio/inbound";
    const streamUrl = "wss://calls.example.test/twilio/media/";
    const now = "2026-09-29T10:00:00.000Z";
    const scope = { tenantId: `fallback-${randomUUID().slice(0, 8)}`, clinicId: "clinic", locationId: "main" };
    const expectedGreeting = { scope, version: "fallback-keypad-v1",
      ownerRef: "synthetic-clinic-approval", approved: true as const,
      approvedText: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow." };
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable",
      async () => ok(true), false, "standaloneMinimal");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
    const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-key-au5" });
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5", rateBudget,
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async () => { throw new Error("greeting must not query Cliniko"); });
    assert.ok(availability.ok);
    const models: string[] = [];
    let primaryAborted = false;
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(target.toString(), Buffer.alloc(32, 0x51)),
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        fallbackNumbers: { [number]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x47),
        now: () => new Date(now) },
      routes: [{ dialedNumber: number, scope, routeVersion: "v1", availability: availability.value, rateBudget,
        clinicDate: () => "2026-09-29", keypadAvailabilityGreeting: expectedGreeting }],
      openai: { apiKey: "synthetic-openai-key", intentModel: "configured-model",
        speechFallbackModel: "tts-1", speechPrimaryFirstChunkMs: 100,
        fetch: (async (url, init) => {
          assert.equal(String(url), "https://api.openai.com/v1/audio/speech");
          const body = JSON.parse(String(init?.body)) as { model: string; input: string };
          models.push(body.model);
          assert.equal(body.input, expectedGreeting.approvedText);
          if (body.model === "gpt-4o-mini-tts") return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              primaryAborted = true;
              reject(new Error("primary canceled"));
            }, { once: true });
          });
          assert.equal(body.model, "tts-1");
          return new Response(Buffer.alloc(960, 0x20), { headers: { "content-type": "audio/pcm" } });
        }) as typeof fetch },
      readiness: async () => ok(true), now: () => now,
      playbackOptions: { stepDeadlineMs: 1_000, firstChunkDeadlineMs: 1_500 },
    });
    assert.ok(prepared.ok);
    server = prepared.value;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: callerPhone };
    const webhook = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(webhook.status, 200);
    const binding = (await webhook.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    caller = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await once(caller, "open");
    const sent: Record<string, unknown>[] = [];
    const greeting = new Promise<void>(resolve => caller!.on("message", data => {
      sent.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (sent.length === 2) resolve();
    }));
    caller.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    caller.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await greeting;
    assert.deepEqual(models, ["gpt-4o-mini-tts", "tts-1"]);
    assert.equal(primaryAborted, true);
    assert.deepEqual(sent.map(item => item.event), ["media", "mark"]);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: (sent[1]?.mark as { name: string }).name } }));
    assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "caller", value: callerPhone },
      { label: "provider_call", value: callSid }]), { ok: true, value: [] });
  } finally {
    caller?.terminate();
    if (server) { server.close(); await once(server, "close"); }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
