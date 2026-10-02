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
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresLedger } from "../../src/storage/postgres-ledger.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const now = "2026-10-01T10:00:00.000Z";
const accountSid = `AC${"4".repeat(32)}`;
const authToken = "synthetic-cross-mode-token";
const webhookUrl = "https://cross-mode.example.test/twilio/inbound";
const streamUrl = "wss://cross-mode.example.test/twilio/media/";
const dialedNumber = "+6125550199";
const callerPhone = "+6145550101";
const patientRef = "private-cross-mode-patient";
const verificationRef = "private-cross-mode-proof";
const offerRef = "synthetic-offer";
const startsAt = "2026-10-08T10:00:00.000Z";

type WireMessage = Readonly<{ event: string; mark?: { name: string } }>;

function messages(socket: WebSocket) {
  const received: WireMessage[] = [];
  socket.on("message", data => { received.push(JSON.parse(data.toString()) as WireMessage); });
  return { received, until(count: number, phase: string): Promise<void> {
    if (received.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`${phase}: signed media timed out`)); }, 5_000);
      const onMessage = () => { if (received.length >= count) { cleanup(); resolve(); } };
      const onClose = () => { cleanup(); reject(new Error(`${phase}: signed media closed after ${received.length} messages`)); };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        socket.off("close", onClose);
      };
      socket.on("message", onMessage);
      socket.on("close", onClose);
    });
  } };
}

/** E2E-222 and E2E-074 use one signed caller script across strict, enabled and emergency-stopped modes. */
test("E2E-222 signed booking needs played confirmation across standalone and embedded modes",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async t => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const names: string[] = [];
  try {
    for (const mode of ["standalone", "embedded", "embeddedStopped"] as const) {
      await t.test(mode === "embeddedStopped" ? "E2E-074 signed emergency write stop after played booking details"
        : `${mode} signed booking path`, async () => {
      const embedded = mode !== "standalone";
      const name = `abby_signed_${mode}_${randomUUID().replaceAll("-", "")}`;
      const target: URL = new URL(adminUrl);
      target.pathname = `/${name}`;
      await sql.raw(`create database "${name}"`).execute(admin);
      names.push(name);
      const db = connectPostgres(target.toString());
      const sockets: WebSocket[] = [];
      let server: ReturnType<typeof createTwilioIngressServer> | undefined;
      try {
        await migrate(db);
        const scope = { tenantId: `signed-${mode}`, clinicId: "clinic", locationId: "main" };
        const readiness = async () => ok(true as const);
        const ledger = embedded ? new PostgresLedger(db, suggested => suggested, readiness, "unsafeReference")
          : undefined;
        const policy = new PostgresPolicyStore(db, referenceDefaultPolicy,
          embedded ? "execute" : "unavailable", readiness,
          embedded, embedded ? "unsafeReference" : "standaloneMinimal");
        assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
        const booking = await policy.changeBookingEnabled(scope, "0", true, "clinic-admin");
        assert.ok(booking.ok);
        assert.equal(booking.value.capabilities.book, embedded ? "execute" : "unavailable");
        if (!embedded) {
          const greeting = await policy.changeGreeting(scope, "1", { scope, version: "signed-booking-v1",
            ownerRef: "clinic-admin", approved: true, approvedText: "Welcome to the clinic.",
            effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2027-09-01T00:00:00.000Z" },
          "clinic-admin");
          assert.ok(greeting.ok);
        }
        const host = new ReferenceClinicHost([{ scope, patientRef, verificationRef,
          expiresAt: "2026-10-01T11:00:00.000Z" }],
        [{ scope, offerRef, serviceRef: "physio", startsAt, expiresAt: "2026-10-01T11:00:00.000Z" }]);
        const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: accountSid,
          dialedNumber, routeVersion: "cross-mode-v1" }]);
        const ingress = new TwilioSignedIngress({ accountSid, authToken,
          publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
          fallbackNumbers: { [dialedNumber]: "+6125550188" },
          bindingKey: Buffer.alloc(32, 0x38), now: () => new Date(now) });
        const callSid = `CA${(mode === "standalone" ? "5" : mode === "embedded" ? "6" : "7").repeat(32)}`;
        const streamSid = `MZ${(mode === "standalone" ? "7" : mode === "embedded" ? "8" : "9").repeat(32)}`;
        const spoken: string[] = [];
        const played = new EventEmitter();
        let constructed = 0;
        const transcription = (sessionId: string) => {
          let utterance = 0;
          return { async accept() { return ok([]); }, async flush(generation: number) {
            utterance += 1;
            return ok([{ kind: "segmentFinal" as const, sessionId, generation,
              utteranceId: `caller-${utterance}`, text: utterance === 1 ? "Book physio" : "Yes",
              quality: "clear" as const }]);
          } };
        };
        const resolveIntent = async (turn: { text: string }) => ok(turn.text === "Book physio"
          ? { kind: "book" as const, verificationRef, offerRef } : { kind: "affirm" as const });
        const synthesis = { async *stream(text: string) { spoken.push(text); yield new Uint8Array(640); } };
        server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
          constructed += 1;
          const sessionId = `session-${mode}`;
          const wire = mode === "standalone"
            ? await createStandaloneTransientVoiceCall({ db, routingHost: routing, stream, send,
              closeTransport: close, readiness, now: () => now, mediaOptions: { silenceMs: 100 },
              transcriptionFactory: transcription, synthesis, resolveIntent })
            : ok(createEmbeddedTwilioVoiceComposition({ event: stream.event, sessionId,
              streamStartedAt: stream.streamStartedAt, send, closeTransport: close,
              ledger: ledger!, policy, routing, host, readiness, now: () => now,
              mediaOptions: { silenceMs: 100 }, transcription: transcription(sessionId),
              synthesis, resolveIntent }));
          assert.ok(wire.ok, wire.ok ? "" : wire.error.kind);
          let playedCount = 0;
          return { async receive(raw: string) {
            const inbound = JSON.parse(raw) as { event?: string };
            const result = await wire.value.receive(raw);
            if (result.ok && inbound.event === "mark") {
              playedCount += 1;
              played.emit(String(playedCount));
            }
            return result;
          }, disconnect: () => wire.value.disconnect() };
        } });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const base = `http://127.0.0.1:${address.port}`;
        const socketUrl = `ws://127.0.0.1:${address.port}/twilio/media/`;
        const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: callerPhone };
        const unsigned = await fetch(`${base}/twilio/inbound`, { method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(form).toString() });
        assert.equal(unsigned.status, 403);
        assert.equal(constructed, 0);
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
        const output = messages(socket);
        let sequence = 1;
        let chunk = 0;
        socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
        socket.send(JSON.stringify({ event: "start", sequenceNumber: String(sequence++), streamSid,
          start: { accountSid, callSid, streamSid, tracks: ["inbound"],
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
            customParameters: { abbyBinding: binding } } }));
        await output.until(2, `${mode} greeting`);
        assert.deepEqual(output.received.map(item => item.event), ["media", "mark"]);
        async function acknowledge(markIndex: number, count: number) {
          const done = once(played, String(count));
          socket.send(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++), streamSid,
            mark: { name: output.received[markIndex]!.mark!.name } }));
          await done;
        }
        function sendFrames() {
          for (let frame = 0; frame < 7; frame += 1) {
            socket.send(JSON.stringify({ event: "media", sequenceNumber: String(sequence++), streamSid,
              media: { track: "inbound", chunk: String(++chunk), timestamp: String((chunk - 1) * 20),
                payload: Buffer.alloc(160, frame < 2 ? 0x9f : 0xff).toString("base64") } }));
          }
        }
        async function speak() {
          const before = output.received.length;
          sendFrames();
          await output.until(before + 2, `${mode} turn ${chunk}`);
          assert.deepEqual(output.received.slice(-2).map(item => item.event), ["media", "mark"]);
        }
        await acknowledge(1, 1);
        await speak();
        assert.equal(host.bookings(scope).length, 0, "voice details cannot commit before playback");
        if (mode === "standalone") {
          assert.equal(spoken.at(-1), "I can't complete that request here.");
        } else {
          assert.match(spoken.at(-1) ?? "", /physio/i);
          const before = await ledger!.read(callIdFor({ accountRef: accountSid, providerCallRef: callSid }), scope);
          assert.ok(before.ok);
          assert.equal(Object.values(before.value.actions)[0]?.status, "awaitingConfirmation");
        }
        await acknowledge(output.received.length - 1, 2);
        assert.equal(host.bookings(scope).length, 0);
        let stoppedVersion: string | undefined;
        if (mode === "embeddedStopped") {
          const stopped = await ledger!.stopWrites(scope, "clinic-admin", "Synthetic clinic incident");
          assert.ok(stopped.ok);
          assert.equal(stopped.value.stopped, true);
          stoppedVersion = stopped.value.version;
        }
        if (embedded) {
          await speak();
          if (mode === "embedded") {
            assert.equal(host.bookings(scope).length, 1);
            assert.equal(spoken.at(-1), "Your booking is confirmed.");
          } else {
            assert.equal(host.bookings(scope).length, 0);
            assert.equal(spoken.at(-1),
              "I can't complete that action now. I'll request staff follow-up, but I can't confirm they've received it yet.");
            assert.equal(spoken.some(text => text.includes("booking is confirmed")), false);
          }
          await acknowledge(output.received.length - 1, 3);
          if (mode === "embeddedStopped") {
            const resumed = await ledger!.resumeWrites(scope, stoppedVersion!, "clinic-admin", "Synthetic recovery");
            assert.ok(resumed.ok);
            assert.equal(host.bookings(scope).length, 0, "resume cannot replay the blocked action");
          }
        } else {
          const closed = once(socket, "close");
          sendFrames();
          await closed;
          assert.equal(host.bookings(scope).length, 0);
          assert.equal(output.received.length, 4, "an unsupported affirmation cannot queue a success notice");
          assert.equal(spoken.some(text => text.includes("booking is confirmed")), false);
        }
        if (socket.readyState === WebSocket.OPEN) {
          const closed = once(socket, "close");
          socket.close();
          await closed;
        }
        const count = await sql<{ count: number }>`select count(*)::int as count from calls`.execute(db);
        assert.equal(count.rows[0]?.count, embedded ? 1 : 0);
        if (mode === "standalone") {
          const canaries = [callSid, callerPhone, patientRef, verificationRef].map((value, index) =>
            ({ label: `private_${index}`, value }));
          assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
          assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
        } else {
          const reopened = connectPostgres(target.toString());
          try {
            const recovered = await new PostgresLedger(reopened, undefined, readiness, "unsafeReference")
              .read(callIdFor({ accountRef: accountSid, providerCallRef: callSid }), scope);
            assert.ok(recovered.ok);
            assert.equal(Object.values(recovered.value.actions)[0]?.status,
              mode === "embedded" ? "committed" : "unsupported");
          } finally { await reopened.destroy(); }
        }
        assert.equal(constructed, 1);
      } finally {
        for (const socket of sockets) socket.terminate();
        if (server) { const closed = once(server, "close"); server.close(); await closed; }
        await db.destroy();
      }
      });
    }
  } finally {
    try { for (const name of names.reverse()) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
