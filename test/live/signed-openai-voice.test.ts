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
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneClinikoVoiceServer } from "../../src/standalone/cliniko-voice-server.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";

test("opt-in patient-free signed local call uses live OpenAI speech and exact Twilio mark",
  { skip: process.env.ABBY_LIVE_VOICE_EVAL !== "1" ||
    process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || !process.env.ABBY_OPENAI_API_KEY,
  timeout: 60_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  const apiKey = process.env.ABBY_OPENAI_API_KEY;
  assert.ok(adminUrl && apiKey);
  const admin = connectPostgres(adminUrl);
  const name = `abby_live_speech_${randomUUID().replaceAll("-", "")}`;
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
    const accountSid = `AC${"7".repeat(32)}`;
    const callSid = `CA${"8".repeat(32)}`;
    const streamSid = `MZ${"9".repeat(32)}`;
    const number = "+6125550199";
    const callerPhone = "+6145550101";
    const authToken = "synthetic-local-openai-speech-token";
    const webhookUrl = "https://calls.example.test/twilio/inbound";
    const streamUrl = "wss://calls.example.test/twilio/media/";
    const now = "2026-09-29T10:00:00.000Z";
    const scope = { tenantId: `live-${randomUUID().slice(0, 8)}`, clinicId: "clinic", locationId: "main" };
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable",
      async () => ok(true), false, "standaloneMinimal");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async () => { throw new Error("greeting must not query Cliniko"); });
    assert.ok(availability.ok);
    const models: string[] = [];
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        fallbackNumbers: { [number]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x48),
        now: () => new Date(now) },
      routes: [{ dialedNumber: number, scope, routeVersion: "v1", availability: availability.value,
        clinicDate: () => "2026-09-29" }],
      openai: { apiKey, intentModel: "gpt-6-luna", speechFallbackModel: "tts-1",
        fetch: (async (url, init) => {
          assert.equal(String(url), "https://api.openai.com/v1/audio/speech");
          const body = JSON.parse(String(init?.body)) as { model: string };
          models.push(body.model);
          return fetch(url, init);
        }) as typeof fetch },
      readiness: async () => ok(true), now: () => now,
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
    let mediaCount = 0;
    let nonSilence = false;
    const marker = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("local speech mark timed out")), 25_000);
      caller!.on("message", raw => {
        const event = JSON.parse(raw.toString()) as { event: string; media?: { payload: string };
          mark?: { name: string } };
        if (event.event === "media") {
          mediaCount += 1;
          const bytes = Buffer.from(event.media?.payload ?? "", "base64");
          if (bytes.some(byte => byte !== 0xff)) nonSilence = true;
        }
        if (event.event === "mark") {
          clearTimeout(timer);
          if (!event.mark?.name) reject(new Error("missing completion mark"));
          else resolve(event.mark.name);
        }
      });
      caller!.once("error", error => { clearTimeout(timer); reject(error); });
      caller!.once("close", () => { clearTimeout(timer); reject(new Error("socket closed before mark")); });
    });
    caller.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    caller.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    const markName = await marker;
    assert.ok(mediaCount > 0 && mediaCount <= 3_000);
    assert.equal(nonSilence, true);
    assert.ok(models.length >= 1 && models.length <= 2);
    assert.equal(models[0], "gpt-4o-mini-tts");
    if (models.length === 2) assert.equal(models[1], "tts-1");
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: markName } }));
    assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "caller", value: callerPhone },
      { label: "provider_call", value: callSid }]), { ok: true, value: [] });
    process.stdout.write(`${JSON.stringify({ modelAttempts: models, mediaCount, nonSilence,
      localMarkReturned: true, realTelephonyEvidence: false })}\n`);
  } finally {
    caller?.terminate();
    if (server) { server.close(); await once(server, "close"); }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
