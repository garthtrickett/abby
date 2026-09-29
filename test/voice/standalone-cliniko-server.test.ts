import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
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
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
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

test("E2E-138 local standalone server wires signed Twilio, speech, uncertain transcription, and private Cliniko storage",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 20_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_server_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let server: ReturnType<typeof createStandaloneClinikoVoiceServer> | undefined;
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
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async () => { throw new Error("uncertain transcript must not read Cliniko"); }, () => now);
    assert.ok(availability.ok);
    const provider = new FakeTranscriptionSocket();
    let modelCalls = 0;
    let synthesisCalls = 0;
    server = createStandaloneClinikoVoiceServer({ db,
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        fallbackNumbers: { [number]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x46),
        now: () => new Date(now) },
      routes: [{ dialedNumber: number, scope, routeVersion: "v1", availability: availability.value,
        clinicDate: () => "2026-09-29" }],
      openai: { apiKey: "synthetic-openai-key", intentModel: "configured-model",
        transcriptionSocketFactory: () => {
          queueMicrotask(() => provider.open());
          return provider as unknown as WebSocket;
        },
        fetch: (async (url, init) => {
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-openai-key");
          if (String(url).endsWith("/audio/speech")) {
            synthesisCalls += 1;
            return new Response(Buffer.alloc(960), { headers: { "content-type": "audio/pcm" } });
          }
          modelCalls += 1;
          throw new Error("uncertain transcript must not reach intent model");
        }) as typeof fetch },
      readiness: async () => ok(true), mediaOptions: { silenceMs: 100 }, now: () => now,
    });
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
    assert.deepEqual(sent.map(item => item.event), ["media", "mark"]);
    assert.equal(synthesisCalls, 1);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: (sent[1]?.mark as { name: string }).name } }));
    const committed = once(provider, "commit");
    const closed = once(caller, "close");
    for (let index = 0; index < 7; index += 1) caller.send(JSON.stringify({ event: "media",
      sequenceNumber: String(index + 3), streamSid, media: { track: "inbound", chunk: String(index + 1),
        timestamp: String(index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
    await committed;
    provider.receive({ type: "input_audio_buffer.committed", item_id: "provider-item" });
    provider.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "provider-item",
      transcript: "Do you have availability on October 2?" });
    assert.equal((await closed)[0], 1008);
    assert.equal(modelCalls, 0);
    assert.equal(provider.terminateCount, 1);
    assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "caller", value: callerPhone },
      { label: "provider_call", value: callSid },
      { label: "spoken_text", value: "Do you have availability on October 2?" }]), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [{ label: "caller", value: callerPhone },
      { label: "provider_call", value: callSid },
      { label: "spoken_text", value: "Do you have availability on October 2?" }]), []);
  } finally {
    caller?.terminate();
    if (server) { server.close(); await once(server, "close"); }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
