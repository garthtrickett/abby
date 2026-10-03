import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { ok } from "../../src/core/model.ts";
import { CallReview } from "../../src/reference/call-review.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTwilioVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryKnowledgeCatalogue } from "../../src/reference/knowledge-catalogue.ts";
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
const authToken = "synthetic-cross-mode-knowledge-token";
const webhookUrl = "https://knowledge.example.test/twilio/inbound";
const streamUrl = "wss://knowledge.example.test/twilio/media/";
const dialedNumber = "+6125550199";
const callerPhone = "+6145550101";
const question = "Where is parking?";
const answer = "Parking is behind the clinic.";
const fallback = "I can't verify that information right now.";

type Outbound = Readonly<{ event: string; mark?: { name: string } }>;

/** E2E-223 sends the same signed caller script through both privacy and host modes. */
test("E2E-223 signed knowledge answer requires embedded approval and remains private in standalone",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const names: string[] = [];
  try {
    for (const mode of ["standalone", "embedded"] as const) {
      const name = `abby_signed_knowledge_${mode}_${randomUUID().replaceAll("-", "")}`;
      const target: URL = new URL(adminUrl);
      target.pathname = `/${name}`;
      await sql.raw(`create database "${name}"`).execute(admin);
      names.push(name);
      const db = connectPostgres(target.toString());
      let server: ReturnType<typeof createTwilioIngressServer> | undefined;
      const sockets: WebSocket[] = [];
      try {
        await migrate(db);
        const scope = { tenantId: `knowledge-${mode}`, clinicId: "clinic", locationId: "main" };
        const readiness = async () => ok(true as const);
        const ledger = mode === "embedded" ? new PostgresLedger(db, suggested => suggested, readiness,
          "unsafeReference") : undefined;
        const policy = withApprovedSyntheticVoice(new PostgresPolicyStore(db, referenceDefaultPolicy,
          mode === "embedded" ? "execute" : "unavailable", readiness,
          mode === "embedded", mode === "embedded" ? "unsafeReference" : "standaloneMinimal"));
        assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin")).ok);
        const knowledge = mode === "embedded" ? new MemoryKnowledgeCatalogue() : undefined;
        const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: accountSid,
          dialedNumber, routeVersion: "knowledge-v1" }]);
        const ingress = new TwilioSignedIngress({ accountSid, authToken,
          publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
          fallbackNumbers: { [dialedNumber]: "+6125550188" },
          bindingKey: Buffer.alloc(32, 0x39), now: () => new Date(now) });
        const spoken = new Map<string, string[]>();
        const played = new EventEmitter();
        let constructed = 0;
        server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
          constructed += 1;
          const callSid = stream.event.key.providerCallRef;
          const sessionId = `session-${callSid}`;
          let playedCount = 0;
          const transcription = (actualSessionId: string) => {
            let utterance = 0;
            return { async accept() { return ok([]); }, async flush(generation: number) {
              utterance += 1;
              return ok([{ kind: "segmentFinal" as const, sessionId: actualSessionId, generation,
                utteranceId: `parking-${utterance}`, text: question, quality: "clear" as const }]);
            } };
          };
          const synthesis = { async *stream(text: string) {
            spoken.set(callSid, [...(spoken.get(callSid) ?? []), text]);
            yield new Uint8Array(640);
          } };
          const resolveIntent = async () => ok({ kind: "answer" as const,
            sourceRefs: ["parking"], proposedText: answer });
          const call = mode === "standalone"
            ? await createStandaloneTransientVoiceCall({ db, routingHost: routing, stream, send,
              closeTransport: close, readiness, now: () => now, mediaOptions: { silenceMs: 100 },
              approvedGreeting: { scope, version: "knowledge-greeting-v1", ownerRef: "clinic-admin",
                approved: true, approvedText: "Welcome to the clinic.",
                effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2027-09-01T00:00:00.000Z" },
              ...syntheticSpeech({ synthesis, transcriptionFactory: transcription }),  resolveIntent })
            : ok(createEmbeddedTwilioVoiceComposition({ event: stream.event, sessionId,
              streamStartedAt: stream.streamStartedAt, send, closeTransport: close,
              ledger: ledger!, policy, routing, host: new ReferenceClinicHost([], []), knowledge: knowledge!,
              readiness, now: () => now, mediaOptions: { silenceMs: 100 },
              ...syntheticSpeech({ synthesis, transcription: transcription(sessionId) }),  resolveIntent }));
          assert.ok(call.ok, call.ok ? "" : call.error.kind);
          return { async receive(raw: string) {
            const inbound = JSON.parse(raw) as { event?: string };
            const result = await call.value.receive(raw);
            if (result.ok && inbound.event === "mark") {
              playedCount += 1;
              played.emit(`${callSid}:${playedCount}`);
            }
            return result;
          }, disconnect: () => call.value.disconnect() };
        } });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const base = `http://127.0.0.1:${address.port}`;
        const socketUrl = `ws://127.0.0.1:${address.port}/twilio/media/`;

        async function signedCall(index: number, expected: string): Promise<string> {
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
          socket.on("message", data => { received.push(JSON.parse(data.toString()) as Outbound); });
          async function until(count: number) {
            if (received.length >= count) return;
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { cleanup(); reject(new Error("signed knowledge media timed out")); }, 5_000);
              const onMessage = () => { if (received.length >= count) { cleanup(); resolve(); } };
              const onClose = () => { cleanup(); reject(new Error(
                `${mode} call ${index} closed after ${received.length} outbound messages`)); };
              const cleanup = () => { clearTimeout(timer); socket.off("message", onMessage); socket.off("close", onClose); };
              socket.on("message", onMessage);
              socket.on("close", onClose);
            });
          }
          let sequence = 1;
          socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
          socket.send(JSON.stringify({ event: "start", sequenceNumber: String(sequence++), streamSid,
            start: { accountSid, callSid, streamSid, tracks: ["inbound"],
              mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
              customParameters: { abbyBinding: binding } } }));
          await until(2);
          assert.deepEqual(received.map(item => item.event), ["media", "mark"]);
          async function acknowledge(markIndex: number, count: number) {
            const done = once(played, `${callSid}:${count}`);
            socket.send(JSON.stringify({ event: "mark", sequenceNumber: String(sequence++), streamSid,
              mark: { name: received[markIndex]!.mark!.name } }));
            await done;
          }
          await acknowledge(1, 1);
          for (let frame = 0; frame < 7; frame += 1) {
            socket.send(JSON.stringify({ event: "media", sequenceNumber: String(sequence++), streamSid,
              media: { track: "inbound", chunk: String(frame + 1), timestamp: String(frame * 20),
                payload: Buffer.alloc(160, frame < 2 ? 0x9f : 0xff).toString("base64") } }));
          }
          await until(4);
          assert.deepEqual(received.slice(-2).map(item => item.event), ["media", "mark"]);
          assert.equal(spoken.get(callSid)?.at(-1), expected);
          await acknowledge(3, 2);
          const closed = once(socket, "close");
          socket.close();
          await closed;
          return callSid;
        }

        const unsigned = await fetch(`${base}/twilio/inbound`, { method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ AccountSid: accountSid, CallSid: `CA${"9".repeat(32)}`,
            To: dialedNumber, From: callerPhone }).toString() });
        assert.equal(unsigned.status, 403);
        assert.equal(constructed, 0);
        const first = await signedCall(5, fallback);
        if (mode === "embedded") {
          const draft = await knowledge!.saveDraft(scope, "parking", "0", "practice-manager", answer,
            "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z", "clinic-admin");
          assert.ok(draft.ok);
          assert.ok((await knowledge!.approve(scope, "parking", draft.value.version, "clinic-admin")).ok);
        }
        const second = await signedCall(6, mode === "embedded" ? answer : fallback);
        assert.equal(constructed, 2);
        const count = await sql<{ count: number }>`select count(*)::int as count from calls`.execute(db);
        assert.equal(count.rows[0]?.count, mode === "embedded" ? 2 : 0);
        if (mode === "standalone") {
          const canaries = [first, second, callerPhone, question, answer].map((value, index) =>
            ({ label: `private_${index}`, value }));
          assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
          assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
        } else {
          const reopened = connectPostgres(target.toString());
          try {
            const review = await new CallReview(new PostgresLedger(reopened, undefined, readiness,
              "unsafeReference")).read(callIdFor({ accountRef: accountSid, providerCallRef: second }), scope);
            assert.ok(review.ok);
            assert.deepEqual(review.value.knowledgeAnswers,
              [{ sourceRef: "parking", version: "2", ownerRef: "practice-manager" }]);
            assert.equal(JSON.stringify(review.value).includes(question), false);
            assert.equal(JSON.stringify(review.value).includes(answer), false);
          } finally { await reopened.destroy(); }
        }
      } finally {
        for (const socket of sockets) socket.terminate();
        if (server) { const closed = once(server, "close"); server.close(); await closed; }
        await db.destroy();
      }
    }
  } finally {
    try { for (const name of names.reverse()) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
