import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createOpenAIAvailabilityIntentResolver } from "../../src/standalone/openai-availability-intent.ts";
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

test("E2E-134 and E2E-137 standalone signed voice keeps the model decision and live SAM state out of PostgreSQL",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_voice_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const suffix = randomUUID().slice(0, 8);
    const scope = { tenantId: `voice-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
    const accountSid = `AC${"1".repeat(32)}`;
    const callSid = `CA${"2".repeat(32)}`;
    const streamSid = `MZ${"3".repeat(32)}`;
    const authToken = "synthetic-twilio-test-token";
    const webhookUrl = "https://calls.example.test/twilio/inbound";
    const streamUrl = "wss://calls.example.test/twilio/media/";
    const callerPhone = "+6145550101";
    const dialedNumber = "+6125550199";
    const callerText = `Do you have appointments available on October 2? caller-private-${suffix}`;
    const appointmentId = `appointment-private-${suffix}`;
    const startsAt = "2026-10-02T00:00:00.000Z";
    const now = "2026-09-29T10:00:00.000Z";
    const readiness = async () => ok(true as const);
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", readiness, false, "standaloneMinimal");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
    const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
      publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
      bindingKey: Buffer.alloc(32, 0x34), now: () => new Date(now) });
    const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: callerPhone };
    const answered = ingress.answerWebhook({ method: "POST", requestTarget: "/twilio/inbound",
      contentType: "application/x-www-form-urlencoded",
      signature: twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
      body: new URLSearchParams(form).toString() });
    assert.ok(answered.ok);
    const binding = answered.value.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    const connected = JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" });
    const start = JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } });
    const authenticated = ingress.authenticateStream({ method: "GET", requestTarget: "/twilio/media/",
      signature: twilio.getExpectedTwilioSignature(authToken, streamUrl, {}), connected, start });
    assert.ok(authenticated.ok);
    let clinikoReads = 0;
    let modelReads = 0;
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async input => {
      clinikoReads += 1;
      const path = new URL(String(input)).pathname;
      if (path === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
        time_zone_identifier: "Australia/Sydney" });
      if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true });
      if (path === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
      if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
        practitioners: [{ id: "22" }] });
      if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
        appointment_types: [{ id: "33" }] });
      if (path.endsWith("/available_times")) return Response.json({ total_entries: 1,
        available_times: [{ appointment_start: startsAt, appointment_id: appointmentId }] });
      throw new Error("unexpected Cliniko request");
    }, () => now);
    assert.ok(availability.ok);
    const sent: Record<string, unknown>[] = [];
    const spoken: string[] = [];
    let sessionId = "";
    const constructed = await createStandaloneTransientVoiceCall({ db,
      routingHost: new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber,
        ...scope, routeVersion: "v1" }]), stream: authenticated.value,
      send(json) { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued"; },
      transcription: {
        async accept(frame) { sessionId = frame.sessionId; return ok([]); },
        async flush(generation) { return ok([{ kind: "segmentFinal", sessionId, generation,
          utteranceId: "one", text: callerText, quality: "clear" }]); },
      },
      synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
      resolveIntent: createOpenAIAvailabilityIntentResolver({ apiKey: "synthetic-model-key",
        model: "configured-model", clinicDate: () => "2026-09-29", fetch: (async (_url, init) => {
          modelReads += 1;
          const input = JSON.parse(String(init?.body));
          assert.equal(input.store, false);
          assert.deepEqual(JSON.parse(input.input[1].content), { callerText });
          assert.equal(String(init?.body).includes(callerPhone), false);
          return Response.json({ status: "completed", output: [{ type: "message", status: "completed",
            content: [{ type: "output_text", text: JSON.stringify({ kind: "availability",
              from: "2026-10-02", to: "2026-10-02" }) }] }] });
        }) as typeof fetch }),
      readiness, availability: availability.value, now: () => now, mediaOptions: { silenceMs: 100 },
    });
    assert.ok(constructed.ok);
    const call = constructed.value;
    assert.equal((await call.receive(connected)).ok, true);
    assert.equal((await call.receive(start)).ok, true);
    assert.deepEqual(sent.slice(0, 2).map(message => message.event), ["media", "mark"]);
    const mark = (sent[1]?.mark as { name: string }).name;
    assert.equal((await call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: mark } }))).ok, true);
    for (let index = 0; index < 7; index += 1) {
      assert.equal((await call.receive(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid,
        media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20),
          payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }))).ok, true);
    }
    assert.ok(sent.length >= 4);
    assert.equal(modelReads, 1);
    assert.ok(clinikoReads >= 6);
    assert.ok(spoken.some(text => /possible times/i.test(text)));
    assert.ok(spoken.every(text => !text.includes(callerText) && !text.includes(appointmentId)));
    assert.equal((await call.receive(JSON.stringify({ event: "stop", sequenceNumber: "10", streamSid,
      stop: { accountSid, callSid } }))).ok, true);
    assert.equal((await call.receive(connected)).ok, false);
    const counts = await sql<{ calls: number; events: number; effects: number; staff: number; pending: number }>`
      select (select count(*)::int from calls) as calls,
             (select count(*)::int from call_events) as events,
             (select count(*)::int from effect_outbox) as effects,
             (select count(*)::int from staff_items) as staff,
             (select count(*)::int from pending_location_calls) as pending`.execute(db);
    assert.deepEqual(counts.rows[0], { calls: 0, events: 0, effects: 0, staff: 0, pending: 0 });
    const canaries = [{ label: "caller_phone", value: callerPhone },
      { label: "caller_text", value: callerText }, { label: "provider_call", value: callSid },
      { label: "appointment_id", value: appointmentId }, { label: "appointment_time", value: startsAt }];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);

    const privateText = `legacy-private-${suffix}`;
    const legacyScope = { ...scope, locationId: "legacy" };
    await sql`insert into clinic_settings (tenant_id, clinic_id, location_id, version, policy)
      values (${scope.tenantId}, ${scope.clinicId}, 'legacy', 0,
        ${JSON.stringify({ scope: legacyScope, policyVersion: "0", bookingEnabled: false, privateText })}::jsonb)`.execute(db);
    const refused = await createStandaloneTransientVoiceCall({ db,
      routingHost: new ReferenceNumberRoutingHost([]), stream: authenticated.value,
      send() { throw new Error("must not send media"); },
      transcriptionFactory() { throw new Error("privacy preflight must precede provider session creation"); },
      synthesis: { async *stream() { yield new Uint8Array(640); } },
      resolveIntent: async () => ok({ kind: "model" }), readiness });
    assert.deepEqual(refused, { ok: false, error: { kind: "unsafeExistingData", areas: ["settings"] } });
  } finally {
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
