import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTwilioVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import type { TwilioWireCall } from "../../src/voice/twilio-ingress-server.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const now = "2026-09-29T10:00:00.000Z";
const day = "2026-10-01";
const start = "2026-09-30T23:00:00.000Z";
const number = "+6125550199";
const caller = "+6145550101";
const accountSid = `AC${"4".repeat(32)}`;
const authToken = "synthetic-portability-token";
const webhookUrl = "https://portable.example.test/twilio/inbound";
const streamUrl = "wss://portable.example.test/twilio/media/";

type Composition = "standalone" | "embedded";
type Case = "shown" | "empty" | "rateLimited";
function value<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, result.ok ? "" : JSON.stringify(result.error));
  return result.value;
}

async function runCase(composition: Composition, scenario: Case, adminUrl: string): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const name = `abby_portable_voice_${suffix}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const admin = connectPostgres(adminUrl);
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let call: TwilioWireCall | undefined;
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const scope = { tenantId: `${composition}-${suffix}`, clinicId: "clinic", locationId: "main" };
    const callSid = `CA${suffix}`;
    const streamSid = `MZ${suffix}`;
    const appointmentId = `appointment-${suffix}`;
    const callerText = `caller-${suffix}`;
    const methods: string[] = [];
    const reader = value(ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5",
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async (input, init) => {
      methods.push(init?.method ?? "GET");
      assert.equal(init?.method, "GET");
      const path = new URL(String(input)).pathname;
      if (path === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
        time_zone_identifier: "Australia/Sydney" });
      if (path === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true });
      if (path === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
      if (path === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
      if (path === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
        appointment_types: [{ id: "33" }] });
      if (path.endsWith("/available_times")) {
        if (scenario === "rateLimited") return new Response(null, { status: 429 });
        return Response.json({ total_entries: scenario === "shown" ? 1 : 0,
          available_times: scenario === "shown" ? [{ appointment_start: start, appointment_id: appointmentId }] : [] });
      }
      throw new Error(`unexpected Cliniko read ${path}`);
    }, () => now));
    const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
      publicStreamUrl: streamUrl, fallbackNumbers: { [number]: "+6125550188" },
      bindingKey: Buffer.alloc(32, 0x36), now: () => new Date(now) });
    const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: caller };
    const answered = value(ingress.answerWebhook({ method: "POST", requestTarget: "/twilio/inbound",
      contentType: "application/x-www-form-urlencoded",
      signature: twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
      body: new URLSearchParams(form).toString() }));
    const binding = answered.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    const connected = JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" });
    const begun = JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } });
    const stream = value(ingress.authenticateStream({ method: "GET", requestTarget: "/twilio/media/",
      signature: twilio.getExpectedTwilioSignature(authToken, streamUrl, {}), connected, start: begun }));
    const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: accountSid,
      dialedNumber: number, routeVersion: "portable-v1" }]);
    const sent: Record<string, unknown>[] = [];
    const spoken: string[] = [];
    let sessionId = "";
    const transcription = { async accept(frame: { sessionId: string }) { sessionId = frame.sessionId; return ok([]); },
      async flush(generation: number) { return ok([{ kind: "segmentFinal" as const, sessionId, generation,
        utteranceId: "caller-one", text: callerText, quality: "clear" as const }]); } };
    const synthesis = { async *stream(text: string) { spoken.push(text); yield new Uint8Array(640); } };
    const send = (json: string) => { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued" as const; };
    const resolveIntent = async () => ok({ kind: "availability" as const, from: day, to: day });
    const readiness = async () => ok(true as const);
    const host = new ReferenceClinicHost([], []);
    if (composition === "standalone") {
      const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", readiness, false, "standaloneMinimal");
      assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
      call = value(await createStandaloneTransientVoiceCall({ db, routingHost: routing, stream,
        send, transcription, synthesis, resolveIntent, readiness, availability: reader,
        approvedGreeting: referenceDefaultPolicy(scope).greeting!, now: () => now,
        mediaOptions: { silenceMs: 100 } }));
    } else {
      const ledger = new MemoryLedger();
      const policy = new MemoryPolicyStore("execute", () => now, readiness);
      assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "host-admin")).ok);
      call = createEmbeddedTwilioVoiceComposition({ event: stream.event,
        streamStartedAt: stream.streamStartedAt, sessionId: `host-session-${suffix}`, send,
        ledger, policy, routing, host, readiness, availability: reader, resolveIntent,
        transcription, synthesis, now: () => now, mediaOptions: { silenceMs: 100 } });
    }
    assert.ok((await call.receive(connected)).ok);
    assert.ok((await call.receive(begun)).ok);
    assert.deepEqual(sent.slice(0, 2).map(item => item.event), ["media", "mark"]);
    assert.ok((await call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: (sent[1]!.mark as { name: string }).name } }))).ok);
    for (let index = 0; index < 7; index += 1) {
      const result = await call.receive(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid,
        media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20),
          payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
      assert.ok(result.ok, JSON.stringify(result));
    }
    assert.deepEqual(sent.slice(2, 4).map(item => item.event), ["media", "mark"]);
    assert.ok(methods.length >= 6 && methods.every(method => method === "GET"));
    assert.equal(host.bookings(scope).length, 0);
    assert.ok(spoken.every(text => !text.includes(callerText) && !text.includes(appointmentId)));
    if (scenario === "shown") assert.match(spoken.at(-1) ?? "", /can't reserve or confirm/);
    if (scenario !== "shown") assert.doesNotMatch(spoken.at(-1) ?? "", /possible times|confirmed/i);
    assert.ok((await call.receive(JSON.stringify({ event: "mark", sequenceNumber: "10", streamSid,
      mark: { name: (sent[3]!.mark as { name: string }).name } }))).ok);
    assert.ok((await call.receive(JSON.stringify({ event: "stop", sequenceNumber: "11", streamSid,
      stop: { accountSid, callSid } }))).ok);
    assert.deepEqual(await db.selectFrom("calls").select("call_id").execute(), []);
    assert.deepEqual(await scanPatientDataCanaries(db, [
      { label: "caller", value: caller }, { label: "caller_text", value: callerText },
      { label: "call", value: callSid }, { label: "appointment", value: appointmentId },
      { label: "time", value: start },
    ]), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), [
      { label: "caller", value: caller }, { label: "call", value: callSid },
      { label: "appointment", value: appointmentId },
    ]), []);
  } finally {
    await call?.disconnect();
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
}

test("E2E-179 signed voice availability corpus is portable across standalone Cliniko and embedded host",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000, concurrency: 6 }, async t => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  await Promise.all((["shown", "empty", "rateLimited"] as const).flatMap(scenario =>
    (["standalone", "embedded"] as const).map(composition =>
      t.test(`${composition} ${scenario}`, () => runCase(composition, scenario, adminUrl)))));
});
