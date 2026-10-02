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
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { syntheticCatalogueApproval } from "../support/synthetic-catalogue-approval.ts";

const accountSid = `AC${"1".repeat(32)}`;
const authToken = "synthetic-token";
const callerNumber = "+6145550101";
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";
const routeVersion = "concurrent-v1";
const greetingSuffix = "Press 1 for possible times today. Press 2 for possible times tomorrow.";
const noStaffNotice = "I can't send a staff request from this call. Please contact the clinic directly.";
const routes = [
  { tenantId: "east-tenant", number: "+6125550199", fallback: "+6125550188", hour: "10", greeting: `East clinic. ${greetingSuffix}` },
  { tenantId: "west-tenant", number: "+6125550299", fallback: "+6125550288", hour: "14", greeting: `West clinic. ${greetingSuffix}` },
] as const;

class SyntheticTranscriptionSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  send(): void {}
  terminate(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  close(): void { this.terminate(); }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
    this.emit("message", Buffer.from(JSON.stringify({ type: "session.updated", session: {
      type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: "gpt-live-transcribe" }, turn_detection: null } },
    } })));
  }
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

type ActiveCall = {
  route: (typeof routes)[number];
  callSid: string;
  streamSid: string;
  binding: string;
  socket: WebSocket;
  messages: Record<string, unknown>[];
  closed: Promise<[number, Buffer]>;
};

async function waitForMessages(call: ActiveCall, count: number): Promise<void> {
  if (call.messages.length >= count) return;
  await bounded(new Promise<void>((resolve, reject) => {
    const onMessage = () => {
      if (call.messages.length >= count) { call.socket.off("message", onMessage); call.socket.off("close", onClose); resolve(); }
    };
    const onClose = (code: number) => { call.socket.off("message", onMessage);
      reject(new Error(`${call.route.tenantId} stream closed before output: ${code}, messages=${call.messages.length}`)); };
    call.socket.on("message", onMessage);
    call.socket.once("close", onClose);
  }), "signed call output");
}

test("E2E-198 eight parallel signed calls isolate tenants and exhaust one Cliniko budget safely",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const databaseName = `abby_test_voice_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const callSids = Array.from({ length: 9 }, () => `CA${randomUUID().replaceAll("-", "")}`);
  const active: ActiveCall[] = [];
  const providerReads: { tenantId: string; path: string; method: string | undefined }[] = [];
  const spoken: string[] = [];
  let availabilityReadsInFlight = 0;
  let peakAvailabilityReadsInFlight = 0;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let server: Server | undefined;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", async () => ok(true),
      false, "standaloneMinimal");
    for (const route of routes) {
      const scope = { tenantId: route.tenantId, clinicId: "clinic", locationId: "main" };
      const changed = await policy.changeAutomationEnabled(scope, "0", true, "synthetic-admin");
      assert.ok(changed.ok);
      assert.ok((await policy.changeGreeting(scope, "0", { scope, version: "concurrent-greeting-v1",
        ownerRef: "synthetic-admin", approved: true, approvedText: route.greeting,
        effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2028-01-01T00:00:00.000Z" },
      "synthetic-admin")).ok);
    }
    const apiKey = "synthetic-key-au5";
    const budget = new PostgresClinikoRequestBudget(db, { apiKey, maxPerMinute: 48 });
    const future = new Date(Date.now() + 3 * 86_400_000);
    const dateParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney",
      year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(future);
    const dateField = (type: string) => dateParts.find(part => part.type === type)?.value;
    const clinicDate = `${dateField("year")}-${dateField("month")}-${dateField("day")}`;
    const zoneName = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney",
      timeZoneName: "longOffset" }).formatToParts(new Date(`${clinicDate}T12:00:00Z`))
      .find(part => part.type === "timeZoneName")?.value;
    const sydneyOffset = zoneName?.match(/^GMT([+-][0-9]{2}:[0-9]{2})$/)?.[1];
    assert.ok(sydneyOffset);
    const voiceRoutes = routes.map(route => {
      const scope = { tenantId: route.tenantId, clinicId: "clinic", locationId: "main" };
      const selection = ClinikoAvailabilityReader.create({ scope, apiKey, rateBudget: budget,
        contactEmail: "test@example.com", businessId: "11", practitionerId: "22",
        appointmentTypeId: "33" }, async (input, init) => {
        const url = new URL(String(input));
        providerReads.push({ tenantId: route.tenantId, path: url.pathname, method: init?.method });
        if (init?.method !== "GET") throw new Error("synthetic Cliniko write refused");
        if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11", business_name: route.tenantId,
          show_in_online_bookings: true, appointment_type_ids: ["33"], time_zone_identifier: "Australia/Sydney" });
        if (url.pathname === "/v1/practitioners/22") return Response.json({ id: "22", display_name: "Synthetic practitioner",
          active: true, show_in_online_bookings: true });
        if (url.pathname === "/v1/appointment_types/33") return Response.json({ id: "33", name: "Consult",
          show_in_online_bookings: true });
        if (url.pathname === "/v1/businesses/11/practitioners") return Response.json({ total_entries: 1,
          practitioners: [{ id: "22" }] });
        if (url.pathname === "/v1/practitioners/22/appointment_types") return Response.json({ total_entries: 1,
          appointment_types: [{ id: "33" }] });
        if (url.pathname.endsWith("/available_times")) {
          availabilityReadsInFlight += 1;
          peakAvailabilityReadsInFlight = Math.max(peakAvailabilityReadsInFlight, availabilityReadsInFlight);
          try {
            await new Promise(resolve => setTimeout(resolve, 40));
            return Response.json({ total_entries: 1,
              available_times: [{ appointment_start: `${url.searchParams.get("from")}T${route.hour}:00:00${sydneyOffset}` }] });
          } finally { availabilityReadsInFlight -= 1; }
        }
        throw new Error("unexpected Cliniko request");
      });
      assert.ok(selection.ok);
      const binding = { accountRef: accountSid, dialedNumber: route.number, routeVersion };
      return { dialedNumber: route.number, scope, routeVersion, availability: selection.value,
        rateBudget: budget, approval: syntheticCatalogueApproval(selection.value, scope, binding, "1"),
        timeZone: "Australia/Sydney", clinicDate: () => clinicDate,
        keypadAvailabilityGreeting: { scope, approved: true as const, version: "concurrent-greeting-v1",
          ownerRef: "synthetic-admin", approvedText: route.greeting } };
    });
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(target.toString(), Buffer.alloc(32, 0x66)),
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        bindingKey: Buffer.alloc(32, 0x66), fallbackNumbers: Object.fromEntries(routes.map(route => [route.number, route.fallback])) },
      routes: voiceRoutes,
      openai: { apiKey: "synthetic-openai", intentModel: "synthetic-model",
        fetch: async (input, init) => {
          assert.equal(String(input), "https://api.openai.com/v1/audio/speech");
          const request = JSON.parse(String(init?.body)) as { input?: unknown };
          assert.equal(typeof request.input, "string");
          const inputText = request.input as string;
          spoken.push(inputText);
          if (inputText === noStaffNotice) return new Response(Buffer.alloc(960, 0x20),
            { headers: { "content-type": "audio/pcm" } });
          const east = inputText.includes("East clinic") || inputText.includes("10:00");
          const west = inputText.includes("West clinic") || inputText.includes("2:00");
          assert.notEqual(east, west, "speech must identify one synthetic route");
          return new Response(Buffer.alloc(960, east ? 0x10 : 0x40),
            { headers: { "content-type": "audio/pcm" } });
        }, transcriptionSocketFactory: () => {
          const socket = new SyntheticTranscriptionSocket();
          queueMicrotask(() => socket.open());
          return socket as unknown as WebSocket;
        } },
      readiness: async () => ok(true), health: async () => true,
      admitWebhook: async event => !!event && event.presentedCallerNumber === callerNumber,
    });
    assert.ok(prepared.ok);
    server = prepared.value;
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const openCall = async (index: number): Promise<ActiveCall> => {
      const route = routes[index % 2]!;
      const callSid = callSids[index]!;
      const form = { AccountSid: accountSid, CallSid: callSid, To: route.number, From: callerNumber };
      const request = () => fetch(`http://127.0.0.1:${port}/twilio/inbound`, { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form) },
        body: new URLSearchParams(form) });
      const [first, duplicate] = await Promise.all([request(), request()]);
      assert.equal(first.status, 200);
      assert.equal(duplicate.status, 200);
      const xml = await first.text();
      const duplicateXml = await duplicate.text();
      assert.equal(xml.replace(/value="[^"]+"/, 'value="binding"'),
        duplicateXml.replace(/value="[^"]+"/, 'value="binding"'));
      const binding = xml.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
      assert.ok(binding);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, { headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
      } });
      const streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
      const call: ActiveCall = { route, callSid, streamSid, binding, socket, messages: [],
        closed: once(socket, "close") as Promise<[number, Buffer]> };
      active.push(call);
      socket.on("message", data => call.messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
      await bounded(once(socket, "open"), "signed stream open");
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
        start: { accountSid, callSid, streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
      return call;
    };
    const calls = await Promise.all(callSids.slice(0, 8).map((_, index) => openCall(index)));
    await Promise.all(calls.map(call => waitForMessages(call, 2)));
    const original = calls[0]!;
    const duplicate = new WebSocket(`ws://127.0.0.1:${port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await bounded(once(duplicate, "open"), "duplicate signed stream open");
    const duplicateClosed = once(duplicate, "close") as Promise<[number, Buffer]>;
    const duplicateStreamSid = `MZ${randomUUID().replaceAll("-", "")}`;
    duplicate.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    duplicate.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: duplicateStreamSid,
      start: { accountSid, callSid: original.callSid, streamSid: duplicateStreamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: original.binding } } }));
    assert.equal((await bounded(duplicateClosed, "duplicate stream refusal"))[0], 1008);
    const greetingMedia = new Map<string, string>();
    for (const call of calls) {
      assert.deepEqual(call.messages.map(message => message.event), ["media", "mark"]);
      const payload = (call.messages[0]!.media as { payload: string }).payload;
      const previous = greetingMedia.get(call.route.tenantId);
      if (previous) assert.equal(payload, previous);
      else greetingMedia.set(call.route.tenantId, payload);
      call.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid: call.streamSid,
        mark: { name: (call.messages[1]!.mark as { name: string }).name } }));
      call.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: call.streamSid,
        dtmf: { track: "inbound_track", digit: "1" } }));
    }
    assert.notEqual(greetingMedia.get("east-tenant"), greetingMedia.get("west-tenant"));
    await Promise.all(calls.map(call => waitForMessages(call, 4)));
    const availabilityMedia = new Map<string, string>();
    for (const call of calls) {
      assert.deepEqual(call.messages.map(message => message.event), ["media", "mark", "media", "mark"]);
      const payload = (call.messages[2]!.media as { payload: string }).payload;
      const previous = availabilityMedia.get(call.route.tenantId);
      if (previous) assert.equal(payload, previous);
      else availabilityMedia.set(call.route.tenantId, payload);
      assert.equal(call.socket.readyState, WebSocket.OPEN);
    }
    assert.notEqual(availabilityMedia.get("east-tenant"), availabilityMedia.get("west-tenant"));
    assert.equal(spoken.filter(text => text.startsWith("East clinic.")).length, 4);
    assert.equal(spoken.filter(text => text.startsWith("West clinic.")).length, 4);
    assert.equal(spoken.filter(text => text.includes("10:00")).length, 4);
    assert.equal(spoken.filter(text => text.includes("2:00")).length, 4);
    assert.equal(providerReads.length, 48);
    assert.ok(providerReads.every(read => read.method === "GET"));
    assert.equal(providerReads.filter(read => read.tenantId === "east-tenant").length, 24);
    assert.equal(providerReads.filter(read => read.tenantId === "west-tenant").length, 24);
    assert.ok(peakAvailabilityReadsInFlight >= 2, "independent calls must overlap during provider latency");
    const budgetRows = await db.selectFrom("cliniko_request_budgets").select(["sent_at_ms", "max_per_minute"]).execute();
    assert.equal(budgetRows.length, 1);
    assert.equal(budgetRows[0]!.max_per_minute, 48);
    assert.equal((budgetRows[0]!.sent_at_ms as number[]).length, 48);
    const overBudget = await openCall(8);
    await waitForMessages(overBudget, 2);
    overBudget.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid: overBudget.streamSid,
      mark: { name: (overBudget.messages[1]!.mark as { name: string }).name } }));
    overBudget.socket.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid: overBudget.streamSid,
      dtmf: { track: "inbound_track", digit: "1" } }));
    await waitForMessages(overBudget, 4);
    assert.deepEqual(overBudget.messages.map(message => message.event), ["media", "mark", "media", "mark"]);
    assert.equal(spoken.at(-1), noStaffNotice);
    assert.equal(providerReads.length, 48, "budget denial must happen before Cliniko HTTP");
    const budgetAfter = await db.selectFrom("cliniko_request_budgets").select("sent_at_ms").executeTakeFirstOrThrow();
    assert.equal((budgetAfter.sent_at_ms as number[]).length, 48);
    await Promise.all([...calls, overBudget].map(async call => {
      call.socket.close(1000);
      assert.equal((await bounded(call.closed, "caller disconnect"))[0], 1000);
    }));
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
    const canaries = [
      { label: "caller", value: callerNumber },
      ...callSids.map((value, index) => ({ label: `provider_call_${index}`, value })),
    ];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
  } finally {
    for (const call of active) call.socket.terminate();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
