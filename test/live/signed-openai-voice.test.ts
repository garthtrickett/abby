import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
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

test("E2E-163 opt-in signed local call recovers uncertain speech and charges keypad Cliniko reads to the shared budget",
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
    const appointmentId = "synthetic-appointment-availability";
    const appointmentTime = "2026-09-30T02:00:00.000Z";
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable",
      async () => ok(true), false, "standaloneMinimal");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
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
      throw new Error("unexpected synthetic Cliniko request");
    }, () => now);
    assert.ok(availability.ok);
    const models: string[] = [];
    const spoken: string[] = [];
    let intentRequests = 0;
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(target.toString(), Buffer.alloc(32, 0x53)),
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        fallbackNumbers: { [number]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x48),
        now: () => new Date(now) },
      routes: [{ dialedNumber: number, scope, routeVersion: "v1", availability: availability.value, rateBudget,
        clinicDate: () => "2026-09-29", keypadAvailabilityGreeting: { scope, version: "live-eval-keypad-v1",
          ownerRef: "synthetic-clinic-approval", approved: true,
          approvedText: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow." } }],
      openai: { apiKey, intentModel: "gpt-6-luna", speechFallbackModel: "tts-1",
        fetch: (async (url, init) => {
          if (String(url) === "https://api.openai.com/v1/responses") {
            intentRequests += 1;
            throw new Error("uncertain speech must not reach intent model");
          }
          assert.equal(String(url), "https://api.openai.com/v1/audio/speech");
          const body = JSON.parse(String(init?.body)) as { model: string; input: string };
          models.push(body.model);
          spoken.push(body.input);
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
    const greetingMediaCount = mediaCount;
    const greetingModelAttempts = models.length;
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: markName } }));
    const followup = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("clarification mark timed out")), 25_000);
      caller!.on("message", raw => {
        const event = JSON.parse(raw.toString()) as { event: string; mark?: { name: string } };
        if (event.event === "mark" && event.mark?.name && event.mark.name !== markName) {
          clearTimeout(timer);
          resolve(event.mark.name);
        }
      });
    });
    const source = readFileSync(new URL("../../eval/audio/availability-thursday.pcm", import.meta.url));
    const ulaw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "s16le",
      "-ar", "16000", "-ac", "1", "-i", "pipe:0", "-ar", "8000", "-ac", "1",
      "-acodec", "pcm_mulaw", "-f", "mulaw", "pipe:1"], { input: source, maxBuffer: 1_000_000 });
    let inboundChunk = 0;
    for (let offset = 0; offset < ulaw.length + 8_000; offset += 160) {
      const payload = new Uint8Array(160).fill(0xff);
      if (offset < ulaw.length) payload.set(ulaw.subarray(offset, offset + 160));
      inboundChunk += 1;
      caller.send(JSON.stringify({ event: "media", sequenceNumber: String(inboundChunk + 2), streamSid,
        media: { track: "inbound", chunk: String(inboundChunk), timestamp: String((inboundChunk - 1) * 20),
          payload: Buffer.from(payload).toString("base64") } }));
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    const followupMark = await followup;
    assert.ok(followupMark);
    assert.ok(mediaCount > greetingMediaCount);
    const afterClarificationMediaCount = mediaCount;
    assert.ok(models.length > greetingModelAttempts && models.length <= greetingModelAttempts + 2);
    assert.equal(intentRequests, 0);
    assert.equal(clinikoReads, 0);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: String(inboundChunk + 3), streamSid,
      mark: { name: followupMark } }));
    const availabilityMark = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("availability mark timed out")), 25_000);
      caller!.on("message", raw => {
        const event = JSON.parse(raw.toString()) as { event: string; mark?: { name: string } };
        if (event.event === "mark" && event.mark?.name &&
            event.mark.name !== markName && event.mark.name !== followupMark) {
          clearTimeout(timer);
          resolve(event.mark.name);
        }
      });
    });
    caller.send(JSON.stringify({ event: "dtmf", sequenceNumber: String(inboundChunk + 4), streamSid,
      dtmf: { track: "inbound_track", digit: "2" } }));
    const thirdMark = await availabilityMark;
    assert.ok(thirdMark);
    assert.ok(mediaCount > afterClarificationMediaCount);
    assert.equal(clinikoReads, 6);
    const budgetRows = await sql<{ sent_at_ms: unknown }>`select sent_at_ms from cliniko_request_budgets`.execute(db);
    assert.equal(budgetRows.rows.length, 1);
    assert.ok(Array.isArray(budgetRows.rows[0]?.sent_at_ms));
    assert.equal(budgetRows.rows[0].sent_at_ms.length, clinikoReads);
    assert.equal(intentRequests, 0);
    assert.match(spoken.at(-1) ?? "", /possible times/i);
    assert.equal((spoken.at(-1) ?? "").includes(appointmentId), false);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: String(inboundChunk + 5), streamSid,
      mark: { name: thirdMark } }));
    assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "caller", value: callerPhone },
      { label: "provider_call", value: callSid }, { label: "appointment", value: appointmentId },
      { label: "appointment_time", value: appointmentTime }]), { ok: true, value: [] });
    process.stdout.write(`${JSON.stringify({ modelAttempts: models, greetingMediaCount,
      clarificationMediaCount: afterClarificationMediaCount - greetingMediaCount,
      availabilityMediaCount: mediaCount - afterClarificationMediaCount, nonSilence,
      localMarksReturned: 3, inboundFrames: inboundChunk, intentRequests, clinikoReads,
      realTelephonyEvidence: false })}\n`);
  } finally {
    caller?.terminate();
    if (server) { server.close(); await once(server, "close"); }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
