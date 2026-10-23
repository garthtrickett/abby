import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { Server } from "node:http";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { ClinikoAvailabilityReader } from "../../src/cliniko/availability.ts";
import { ok, err } from "../../src/core/model.ts";
import { voiceClinicScope } from "../../src/core/voice-profile.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneClinikoVoiceServer } from "../../src/standalone/cliniko-voice-server.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { PostgresActiveCallClaims } from "../../src/storage/postgres-active-call-claims.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { OpenAIVoiceProfileHost } from "../../src/voice/openai-voice-profile.ts";
import { syntheticCatalogueApproval } from "./synthetic-catalogue-approval.ts";
import type { syntheticRealtimeSpeech } from "./synthetic-realtime-speech.ts";
import { syntheticSpeechQuality } from "./seed-synthetic-voice-preferences.ts";

const now = "2026-10-03T01:00:00.000Z", number = "+6125550199", callerPhone = "+6145550101";
const accountSid = `AC${"1".repeat(32)}`, authToken = "synthetic-voice-profile-token";
const webhookUrl = "https://calls.example.test/twilio/inbound", streamUrl = "wss://calls.example.test/twilio/media/";
export const profilePatientCanary = "private-profile-appointment-259";
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "signed voice profile observation timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
class SpeechSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING; bufferedAmount = 0; closeCount = 0;
  sessions: unknown[] = [];
  send(raw: string) {
    const event = JSON.parse(raw) as { type: string; session?: unknown };
    if (event.type === "session.update") {
      this.sessions.push(event.session);
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "session.updated", session: event.session }))));
    }
  }
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  terminate() { if (this.readyState === WebSocket.CLOSED) return; this.closeCount++; this.readyState = WebSocket.CLOSED; this.emit("close"); }
  close() { this.terminate(); }
}
export type ProfileCaller = Readonly<{ socket: WebSocket; ready: boolean; messages: readonly { event: string; mark?: { name: string } }[]; acknowledge(): Promise<void>; availability(): Promise<void>; close(): Promise<void> }>;
export type StandaloneProfileFixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(db: ReturnType<typeof connectPostgres>, connectionString: string, assignServer: (server: Server) => void,
                       callers: Set<WebSocket>, realtime?: ReturnType<typeof syntheticRealtimeSpeech>, firstChunkDeadlineMs = 5_000) {
  const scope = { tenantId: randomUUID(), clinicId: "clinic", locationId: "main" };
  const requests: Array<{ input: string; voice: string; model: string }> = [], providers: SpeechSocket[] = [];
  let qualityApproved = true, reads = 0;
  const quality = syntheticSpeechQuality(voiceClinicScope(scope));
  const host = new OpenAIVoiceProfileHost({ apiKey: "synthetic-profile-key", mode: "keypadAvailability",
    ...(realtime ? { primaryModel: "gpt-realtime-2.1-mini", speechSocketFactory: realtime.socketFactory,
      runtime: { playbackOptions: { firstChunkDeadlineMs } } } : {}),
    quality: (candidate, hash) => qualityApproved ? quality(candidate, hash) : err({ kind: "readinessFailed", missing: ["voiceProfile"] }),
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/audio/speech");
      requests.push(JSON.parse(String(init?.body)) as typeof requests[number]);
      return new Response(Buffer.alloc(960), { headers: { "content-type": "audio/pcm" } });
    }, socketFactory: () => {
      const provider = new SpeechSocket(); providers.push(provider); queueMicrotask(() => provider.open());
      return provider as unknown as WebSocket;
    },
  });
  const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", async () => ok(true),
    false, "standaloneMinimal", false, "unavailable", undefined, undefined, host);
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "synthetic-admin")).ok);
  const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-key-au5" });
  const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5", rateBudget, contactEmail: "test@example.com",
    businessId: "11", practitionerId: "22", appointmentTypeId: "33" }, async input => {
    reads++;
    const url = new URL(String(input));
    if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", show_in_online_bookings: true,
      appointment_type_ids: ["33"], time_zone_identifier: "Australia/Sydney" });
    if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", active: true, show_in_online_bookings: true });
    if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", show_in_online_bookings: true });
    if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1, practitioners: [{ id: "22" }] });
    if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1, appointment_types: [{ id: "33" }] });
    assert.ok(url.pathname.endsWith("/available_times"));
    assert.equal(url.searchParams.get("from"), "2026-10-04");
    return Response.json({ total_entries: 1, available_times: [{ appointment_start: "2026-10-04T00:00:00.000Z", appointment_id: profilePatientCanary }] });
  }, () => now);
  assert.ok(availability.ok);
  const server = await createStandaloneClinikoVoiceServer({ db, ...(realtime ? {
    playbackOptions: { firstChunkDeadlineMs },
    speechQuality: (candidate, hash) => qualityApproved ? quality(candidate, hash) : err({ kind: "readinessFailed", missing: ["voiceProfile"] }),
  } : { voiceProfiles: host }),
    activeCallClaims: new PostgresActiveCallClaims(connectionString, Buffer.alloc(32, 0x61)),
    twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
      fallbackNumbers: { [number]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x62), now: () => new Date(now) },
    routes: [{ scope, dialedNumber: number, routeVersion: "v1", availability: availability.value, rateBudget,
      approval: syntheticCatalogueApproval(availability.value, scope, { accountRef: accountSid, dialedNumber: number, routeVersion: "v1" }),
      timeZone: "Australia/Sydney", clinicDate: () => "2026-10-03", keypadAvailabilityGreeting: { scope, version: "profile-greeting.v1",
        approved: true, ownerRef: "synthetic-clinic-owner", approvedText: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow." } }],
    openai: { apiKey: "synthetic-profile-key", intentModel: "synthetic-model", ...(realtime ? {
      speechModel: "gpt-realtime-2.1-mini", speechSocketFactory: realtime.socketFactory, transcriptionSocketFactory: () => {
        const provider = new SpeechSocket(); providers.push(provider); queueMicrotask(() => provider.open()); return provider as unknown as WebSocket;
      } } : {}) }, readiness: async () => ok(true), now: () => now,
  });
  assert.ok(server.ok); assignServer(server.value); server.value.listen(0, "127.0.0.1"); await once(server.value, "listening");
  const address = server.value.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  const observations: Array<Array<{ event: string; mark?: { name: string } }>> = [];
  async function requestCall() {
    const callSid = `CA${randomUUID().replaceAll("-", "")}`;
    const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: callerPhone };
    const response = await fetch(`http://127.0.0.1:${port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    return { response, callSid };
  }
  async function attachCall({ response, callSid }: Awaited<ReturnType<typeof requestCall>>, acknowledgeGreeting = true): Promise<ProfileCaller> {
    const streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
    assert.equal(response.status, 200); const xml = await response.text();
    assert.match(xml, /<Dial>\+6125550188<\/Dial>/);
    const binding = xml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1]; assert.ok(binding);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } }); callers.add(socket);
    const messages: Array<{ event: string; mark?: { name: string } }> = [];
    observations.push(messages);
    socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
    await once(socket, "open"); let sequence = 1;
    const send = (event: object) => socket.send(JSON.stringify({ sequenceNumber: String(sequence++), streamSid, ...event }));
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    send({ event: "start", start: { accountSid, callSid, streamSid, tracks: ["inbound"],
      mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { abbyBinding: binding } } });
    await waitFor(() => messages.some(message => message.event === "mark") || socket.readyState === WebSocket.CLOSED);
    const ready = socket.readyState !== WebSocket.CLOSED;
    async function acknowledge(mark: { name: string }) { send({ event: "mark", mark }); }
    if (ready && acknowledgeGreeting) { const mark = messages.find(message => message.event === "mark")?.mark; assert.ok(mark); await acknowledge(mark); }
    return { socket, ready, messages, async acknowledge() {
      const mark = messages.filter(message => message.event === "mark").at(-1)?.mark; assert.ok(mark); await acknowledge(mark);
    }, async availability() {
      assert.equal(socket.readyState, WebSocket.OPEN);
      const prior = messages.filter(message => message.event === "mark").length;
      send({ event: "dtmf", dtmf: { track: "inbound_track", digit: "2" } });
      await waitFor(() => messages.filter(message => message.event === "mark").length > prior || socket.readyState === WebSocket.CLOSED);
      assert.equal(socket.readyState, WebSocket.OPEN);
      const mark = messages.filter(message => message.event === "mark").at(-1)?.mark; assert.ok(mark); await acknowledge(mark);
    }, async close() { if (socket.readyState !== WebSocket.CLOSED) { socket.close(); await once(socket, "close"); } callers.delete(socket); } };
  }
  const openCall = async (acknowledgeGreeting = true) => attachCall(await requestCall(), acknowledgeGreeting);
  return { scope, policy, db, requests, providers, requestCall, attachCall, openCall, observations, reads: () => reads, withdraw: () => { qualityApproved = false; } };
}
export async function withStandaloneVoiceProfile(run: (app: StandaloneProfileFixture) => Promise<void>,
  realtime?: ReturnType<typeof syntheticRealtimeSpeech>, firstChunkDeadlineMs?: number): Promise<void> {
  assert.equal(process.env.ABBY_ISOLATED_POSTGRES_PROBE, "1"); assert.ok(process.env.DATABASE_URL);
  const admin = connectPostgres(process.env.DATABASE_URL), name = `abby_profile_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(process.env.DATABASE_URL); target.pathname = `/${name}`;
  let created = false, db: ReturnType<typeof connectPostgres> | undefined, server: Server | undefined;
  const callers = new Set<WebSocket>();
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    await run(await fixture(db, target.toString(), value => { server = value; }, callers, realtime, firstChunkDeadlineMs));
  } finally {
    for (const caller of callers) caller.terminate();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); } finally { await admin.destroy(); }
  }
}
