import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTwilioVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

const now = "2026-10-01T10:00:00.000Z";
const accountSid = `AC${"4".repeat(32)}`;
const authToken = "synthetic-urgent-setting-token";
const dialedNumber = "+6125550199";
const callerPhone = "+6145550101";
const webhookUrl = "https://urgent.example.test/twilio/inbound";
const streamUrl = "wss://urgent.example.test/twilio/media/";
const script = "If you need immediate help, contact your local emergency service now.";
const fallback = "I can't give advice on that request. Please contact the clinic directly.";
const symptom = "I have chest pain and need urgent help";

type Outbound = { event: string; mark?: { name: string } };

test("E2E-232 signed embedded call speaks only the urgent script captured at admission",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const databaseName = `abby_signed_urgent_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let server: ReturnType<typeof createTwilioIngressServer> | undefined;
  const sockets: WebSocket[] = [];
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const scope = { tenantId: "signed-urgent", clinicId: "clinic", locationId: "main" };
    const readiness = async () => ok(true as const);
    const ledger = new PostgresLedger(db, suggested => suggested, readiness, "unsafeReference");
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "requestOnly", readiness,
      true, "unsafeReference");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
    const host = new ReferenceClinicHost([], []);
    const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: accountSid,
      dialedNumber, routeVersion: "urgent-v1" }]);
    const ingress = new TwilioSignedIngress({ accountSid, authToken,
      publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
      fallbackNumbers: { [dialedNumber]: "+6125550188" },
      bindingKey: Buffer.alloc(32, 0x41), now: () => new Date(now) });
    const spoken = new Map<string, string[]>();
    const played = new EventEmitter();
    let constructed = 0;
    server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
      constructed += 1;
      const callSid = stream.event.key.providerCallRef;
      const sessionId = `session-${callSid}`;
      let playedCount = 0;
      const transcription = { async accept() { return ok([]); }, async flush(generation: number) {
        return ok([{ kind: "segmentFinal" as const, sessionId, generation,
          utteranceId: "urgent-request", text: symptom, quality: "clear" as const }]);
      } };
      const synthesis = { async *stream(text: string) {
        spoken.set(callSid, [...(spoken.get(callSid) ?? []), text]);
        yield new Uint8Array(640);
      } };
      const wire = createEmbeddedTwilioVoiceComposition({ event: stream.event, sessionId,
        streamStartedAt: stream.streamStartedAt, send, closeTransport: close,
        ledger, policy, routing, host, readiness, now: () => now,
        mediaOptions: { silenceMs: 100 }, transcription, synthesis,
        resolveIntent: async () => ok({ kind: "handoff" as const, reason: "potentiallyUrgent" as const }) });
      return { async receive(raw: string) {
        const inbound = JSON.parse(raw) as { event?: string };
        const result = await wire.receive(raw);
        if (result.ok && inbound.event === "mark") played.emit(`${callSid}:${++playedCount}`);
        return result;
      }, disconnect: () => wire.disconnect() };
    } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const socketUrl = `ws://127.0.0.1:${address.port}/twilio/media/`;

    async function signedCall(index: number, afterGreeting?: () => Promise<void>) {
      const callSid = `CA${String(index).repeat(32)}`;
      const streamSid = `MZ${String(index).repeat(32)}`;
      const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: callerPhone };
      const response = await fetch(`${base}/twilio/inbound`, { method: "POST", headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
      }, body: new URLSearchParams(form).toString() });
      assert.equal(response.status, 200);
      const binding = (await response.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
      assert.ok(binding);
      const socket = new WebSocket(socketUrl, { headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
      } });
      sockets.push(socket);
      await once(socket, "open");
      const received: Outbound[] = [];
      socket.on("message", data => received.push(JSON.parse(data.toString()) as Outbound));
      const until = (count: number, phase: string): Promise<void> => received.length >= count
        ? Promise.resolve() : new Promise((resolve, reject) => {
          const timer = setTimeout(() => { cleanup(); reject(new Error(`${phase} timed out`)); }, 8_000);
          const onMessage = () => { if (received.length >= count) { cleanup(); resolve(); } };
          const onClose = () => { cleanup(); reject(new Error(`${phase} closed early`)); };
          const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); socket.off("close", onClose); };
          socket.on("message", onMessage);
          socket.on("close", onClose);
        });
      let sequence = 1;
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      socket.send(JSON.stringify({ event: "start", sequenceNumber: String(sequence++), streamSid,
        start: { accountSid, callSid, streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
      await until(2, "greeting");
      assert.deepEqual(received.map(item => item.event), ["media", "mark"]);
      const acknowledged = once(played, `${callSid}:1`);
      socket.send(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++), streamSid,
        mark: { name: received[1]!.mark!.name } }));
      await acknowledged;
      await afterGreeting?.();
      for (let frame = 0; frame < 7; frame += 1) {
        socket.send(JSON.stringify({ event: "media", sequenceNumber: String(sequence++), streamSid,
          media: { track: "inbound", chunk: String(frame + 1), timestamp: String(frame * 20),
            payload: Buffer.alloc(160, frame < 2 ? 0x9f : 0xff).toString("base64") } }));
      }
      await until(4, "urgent response");
      assert.deepEqual(received.slice(-2).map(item => item.event), ["media", "mark"]);
      const responseText = spoken.get(callSid)?.at(-1);
      const responseMarked = once(played, `${callSid}:2`);
      socket.send(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++), streamSid,
        mark: { name: received[3]!.mark!.name } }));
      await responseMarked;
      const closed = once(socket, "close");
      socket.close();
      await closed;
      return { callSid, responseText };
    }

    const unsigned = await fetch(`${base}/twilio/inbound`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ AccountSid: accountSid, CallSid: `CA${"9".repeat(32)}`,
        To: dialedNumber, From: callerPhone }).toString() });
    assert.equal(unsigned.status, 403);
    assert.equal(constructed, 0);
    assert.equal((await signedCall(5)).responseText, fallback);
    const approved = await policy.changeUrgentResponse(scope, "0", { scope,
      version: "urgent-v1", ownerRef: "clinic-admin", approvedText: script, approved: true,
      effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-10-02T00:00:00.000Z",
    }, "clinic-admin");
    assert.ok(approved.ok);
    const active = await signedCall(6, async () => {
      const disabled = await policy.changeUrgentResponse(scope, "1", undefined, "clinic-admin");
      assert.ok(disabled.ok);
    });
    assert.equal(active.responseText,
      `${script} I can request staff follow-up, but I can't confirm they have received it yet.`);
    const captured = await ledger.read(callIdFor({ accountRef: accountSid,
      providerCallRef: active.callSid }), scope);
    assert.ok(captured.ok);
    assert.equal(captured.value.policy.urgentResponse?.approvedText, script);
    assert.equal(Object.values(captured.value.staffItems)[0]?.reason, "potentiallyUrgent");
    assert.equal(JSON.stringify(captured.value).includes(symptom), false);
    assert.equal((await signedCall(7)).responseText, fallback);
    assert.equal(constructed, 3);
    assert.equal(host.bookings(scope).length, 0);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (server) { const closed = once(server, "close"); server.close(); await closed; }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
