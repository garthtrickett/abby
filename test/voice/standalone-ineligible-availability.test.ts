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
import { PostgresActiveCallClaims } from "../../src/storage/postgres-active-call-claims.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { syntheticCatalogueApproval } from "../support/synthetic-catalogue-approval.ts";

test("E2E-153 signed keypad call refuses availability when Cliniko business is not online-booking eligible",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 20_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_ineligible_voice_${randomUUID().replaceAll("-", "")}`;
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
    const accountSid = `AC${"a".repeat(32)}`;
    const callSid = `CA${"b".repeat(32)}`;
    const streamSid = `MZ${"c".repeat(32)}`;
    const dialedNumber = "+6125550199";
    const callerPhone = "+6145550101";
    const authToken = "synthetic-ineligible-voice-token";
    const webhookUrl = "https://calls.example.test/twilio/inbound";
    const streamUrl = "wss://calls.example.test/twilio/media/";
    const now = "2026-09-29T10:00:00.000Z";
    const scope = { tenantId: `ineligible-${randomUUID().slice(0, 8)}`, clinicId: "clinic", locationId: "main" };
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable",
      async () => ok(true), false, "standaloneMinimal");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
    let businessReads = 0;
    let availableTimeReads = 0;
    const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey: "synthetic-key-au5" });
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey: "synthetic-key-au5", rateBudget,
      contactEmail: "test@example.com", businessId: "11", practitionerId: "22", appointmentTypeId: "33" },
    async input => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/businesses/11") {
        businessReads += 1;
        return Response.json({ id: "11", show_in_online_bookings: false, appointment_type_ids: ["33"] });
      }
      if (url.pathname.endsWith("/available_times")) availableTimeReads += 1;
      throw new Error("ineligible business must stop Cliniko reads");
    });
    assert.ok(availability.ok);
    const spoken: string[] = [];
    let modelCalls = 0;
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(target.toString(), Buffer.alloc(32, 0x52)),
      twilio: { accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
        fallbackNumbers: { [dialedNumber]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x49),
        now: () => new Date(now) },
      routes: [{ dialedNumber, scope, routeVersion: "v1", availability: availability.value, rateBudget,
        approval: syntheticCatalogueApproval(availability.value, scope, { accountRef: accountSid,
          dialedNumber, routeVersion: "v1" }),
        clinicDate: () => "2026-09-29", keypadAvailabilityGreeting: { scope, version: "ineligible-keypad-v1",
          ownerRef: "synthetic-clinic-approval", approved: true,
          approvedText: "This is Abby, an AI receptionist. Press 1 for possible times today. Press 2 for possible times tomorrow." } }],
      openai: { apiKey: "synthetic-openai-key", intentModel: "configured-model",
        fetch: (async (url, init) => {
          if (String(url) !== "https://api.openai.com/v1/audio/speech") {
            modelCalls += 1;
            throw new Error("keypad request must not use an intent model");
          }
          spoken.push((JSON.parse(String(init?.body)) as { input: string }).input);
          return new Response(Buffer.alloc(960, 0x20), { headers: { "content-type": "audio/pcm" } });
        }) as typeof fetch },
      readiness: async () => ok(true), now: () => now,
    });
    assert.ok(prepared.ok);
    server = prepared.value;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: callerPhone };
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
    let markCount = 0;
    let resolveMark: ((name: string) => void) | undefined;
    const waitForMark = () => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { resolveMark = undefined; reject(new Error("local mark timed out")); }, 5_000);
      resolveMark = name => { clearTimeout(timer); resolveMark = undefined; resolve(name); };
    });
    caller.on("message", raw => {
      const event = JSON.parse(raw.toString()) as { event: string; mark?: { name: string } };
      if (event.event === "mark") {
        assert.ok(event.mark?.name);
        markCount += 1;
        resolveMark?.(event.mark.name);
      }
    });
    const greetingMark = waitForMark();
    caller.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    caller.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    const firstMark = await greetingMark;
    assert.equal(markCount, 1);
    const fallbackMark = waitForMark();
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid, mark: { name: firstMark } }));
    caller.send(JSON.stringify({ event: "dtmf", sequenceNumber: "3", streamSid,
      dtmf: { track: "inbound_track", digit: "1" } }));
    const secondMark = await fallbackMark;
    assert.equal(markCount, 2);
    assert.equal(businessReads, 1);
    assert.equal(availableTimeReads, 0);
    assert.equal(modelCalls, 0);
    assert.equal(spoken.length, 2);
    assert.match(spoken[1]!, /contact the clinic directly/i);
    assert.equal(/possible times|confirmed|booked/i.test(spoken[1]!), false);
    caller.send(JSON.stringify({ event: "mark", sequenceNumber: "4", streamSid,
      mark: { name: secondMark } }));
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
