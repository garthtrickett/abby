import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { sql } from "kysely";
import twilio from "twilio";
import WebSocket from "ws";
import { ok } from "../../src/core/model.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { createStandaloneTransientVoiceCall } from "../../src/standalone/transient-voice-composition.ts";
import { VerifiedAppointmentReadSession } from "../../src/standalone/verified-appointment-read-session.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const at = "2026-10-01T10:00:00.000Z";
const startsAt = "2026-10-02T10:00:00.000Z";
const endsAt = "2026-10-02T10:30:00.000Z";
const secondStartsAt = "2026-10-03T10:00:00.000Z";
const secondEndsAt = "2026-10-03T10:30:00.000Z";
const token = "trustedHostTokenForCall";
const accountSid = `AC${"1".repeat(32)}`;
const authToken = "synthetic-twilio-test-token";
const dialedNumber = "+6125550199";
const callerPhone = "+6145550101";
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";

type WireMessage = Readonly<{ event: string; mark?: { name: string } }>;

function messages(socket: WebSocket) {
  const received: WireMessage[] = [];
  socket.on("message", data => { received.push(JSON.parse(data.toString()) as WireMessage); });
  return {
    received,
    until(count: number): Promise<void> {
      if (received.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("synthetic media timed out")); }, 5_000);
        const onMessage = () => { if (received.length >= count) { cleanup(); resolve(); } };
        const onClose = (code: number) => { cleanup(); reject(new Error(`synthetic media closed early: code ${code}, ${received.length} messages`)); };
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("message", onMessage);
          socket.off("close", onClose);
        };
        socket.on("message", onMessage);
        socket.on("close", onClose);
      });
    },
  };
}

test("E2E-203 E2E-225 signed appointment selection requires played options and cannot borrow another call's proof",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 30_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const name = `abby_proof_wire_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let server: ReturnType<typeof createTwilioIngressServer> | undefined;
  const sockets: WebSocket[] = [];
  try {
    await sql.raw(`create database "${name}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    const suffix = randomUUID().slice(0, 8);
    const scope = { tenantId: `proof-wire-${suffix}`, clinicId: "clinic", locationId: "frontdesk" };
    const readiness = async () => ok(true as const);
    const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", readiness, false, "standaloneMinimal");
    assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "test-operator")).ok);
    assert.ok((await policy.changeGreeting(scope, "0", { scope, version: "proof-transport-greeting-v1",
      ownerRef: "test-operator", approved: true, approvedText: "Welcome to the clinic.",
      effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveUntil: "2027-09-01T00:00:00.000Z" },
    "test-operator")).ok);
    const routingHost = new ReferenceNumberRoutingHost([{ accountRef: accountSid,
      dialedNumber, ...scope, routeVersion: "v1" }]);
    const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
      publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
      bindingKey: Buffer.alloc(32, 0x54), now: () => new Date(at) });
    const verified = new Map<string, VerifiedAppointmentReadSession>();
    const proofRefs = new Map<string, string>();
    const spoken = new Map<string, string[]>();
    const released = new Map<string, Promise<void>>();
    let detailReads = 0;
    let writes = 0;
    let constructed = 0;
    const provider: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method !== "GET") writes += 1;
      if (url.pathname === "/v1/businesses/11") return Response.json({ id: "11",
        time_zone_identifier: "Australia/Sydney", archived_at: null });
      assert.equal(url.pathname, "/v1/individual_appointments");
      detailReads += 1;
      assert.equal(url.searchParams.getAll("q[]").includes("patient_id:=23"), true);
      return Response.json({ total_entries: 2, individual_appointments: [
        { id: "44", starts_at: startsAt, ends_at: endsAt,
          patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/23" } },
          business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
          cancelled_at: null, archived_at: null, deleted_at: null,
          patient_name: "PRIVATE PATIENT CANARY", notes: "PRIVATE NOTE CANARY" },
        { id: "45", starts_at: secondStartsAt, ends_at: secondEndsAt,
          patient: { links: { self: "https://api.au5.cliniko.com/v1/patients/23" } },
          business: { links: { self: "https://api.au5.cliniko.com/v1/businesses/11" } },
          cancelled_at: null, archived_at: null, deleted_at: null,
          patient_name: "PRIVATE PATIENT CANARY", notes: "PRIVATE NOTE CANARY" },
      ] });
    };
    server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
      constructed += 1;
      const callSid = stream.event.key.providerCallRef;
      spoken.set(callSid, []);
      let turnNumber = 0;
      const composed = await createStandaloneTransientVoiceCall({ db: db!, routingHost, stream, send,
        closeTransport: close, readiness, now: () => at, mediaOptions: { silenceMs: 100 },
        transcriptionFactory: sessionId => ({
          async accept() { return ok([]); },
          async flush(generation) { turnNumber += 1; return ok([{ kind: "segmentFinal", sessionId, generation,
            utteranceId: `request-${turnNumber}`,
            text: turnNumber === 1 ? "What are my appointments?" : "Choose second", quality: "clear" }]); },
        }),
        synthesis: { async *stream(text) { spoken.get(callSid)!.push(text); yield new Uint8Array(640); } },
        resolveIntent: async turn => {
          assert.equal(JSON.stringify(turn).includes(callerPhone), false);
          assert.equal(JSON.stringify(turn).includes("PRIVATE"), false);
          const verificationRef = proofRefs.get(callSid) ?? "unverified-reference";
          return turn.text === "Choose second"
            ? ok({ kind: "appointmentSelection", verificationRef, choice: 2 })
            : ok({ kind: "appointments", verificationRef,
              from: at, to: "2026-10-05T10:00:00.000Z" });
        },
        verifiedAppointmentRead: (receipt, inbound, sessionId) => {
          const result = VerifiedAppointmentReadSession.create({ receipt, inbound, sessionId,
            policyVersion: "verification-v1", maxAttempts: 2,
            lookup: { async candidates(readScope, number) {
              assert.equal(readScope.tenantId, scope.tenantId);
              assert.equal(number, callerPhone);
              return ok({ kind: "one", candidateIds: ["23"] });
            } },
            authority: { async attest(request) { return ok({ scope: request.scope,
              callId: request.callId, sessionId: request.sessionId, patientId: "23",
              operations: [request.operation], policyVersion: request.policyVersion }); } },
            policy: { async current() { return ok({ scope, enabled: true, version: "verification-v1" }); } },
            clock: () => at,
            cliniko: { apiKey: "synthetic-key-au5", contactEmail: "test@example.com", businessId: "11" },
            fetchPort: provider });
          assert.ok(result.ok);
          verified.set(callSid, result.value);
          return result.value;
        },
      });
      assert.ok(composed.ok);
      let markReleased!: () => void;
      released.set(callSid, new Promise(resolve => { markReleased = resolve; }));
      return { receive: raw => composed.value.receive(raw),
        async disconnect() { try { await composed.value.disconnect(); } finally { markReleased(); } } };
    } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const socketUrl = `ws://127.0.0.1:${address.port}/twilio/media/`;
    const unsigned = await fetch(`${base}/twilio/inbound`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ AccountSid: accountSid, CallSid: `CA${"9".repeat(32)}`,
        To: dialedNumber, From: callerPhone }).toString() });
    assert.equal(unsigned.status, 403);
    assert.equal(constructed, 0);
    const unsignedSocket = new WebSocket(socketUrl);
    sockets.push(unsignedSocket);
    const rejected = await new Promise<string>(resolve => unsignedSocket.once("error", error => resolve(error.message)));
    assert.match(rejected, /403/);
    assert.equal(constructed, 0);

    async function openCall(callSid: string, streamSid: string) {
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
      const output = messages(socket);
      socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
        start: { accountSid, callSid, streamSid, tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          customParameters: { abbyBinding: binding } } }));
      await output.until(2);
      assert.deepEqual(output.received.slice(0, 2).map(item => item.event), ["media", "mark"]);
      assert.ok(verified.has(callSid));
      socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
        mark: { name: output.received[1]!.mark!.name } }));
      return { socket, output, callSid, streamSid };
    }
    async function requestAppointment(call: Awaited<ReturnType<typeof openCall>>,
                                      startSequence = 3, outputCount = 4, startChunk = 1) {
      for (let index = 0; index < 7; index += 1) {
        call.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(index + startSequence),
          streamSid: call.streamSid, media: { track: "inbound", chunk: String(index + startChunk),
            timestamp: String((index + startSequence - 3) * 20),
            payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
      }
      await call.output.until(outputCount);
      assert.deepEqual(call.output.received.slice(outputCount - 2, outputCount).map(item => item.event), ["media", "mark"]);
    }

    const firstSid = `CA${"2".repeat(32)}`;
    const first = await openCall(firstSid, `MZ${"3".repeat(32)}`);
    const issued = await verified.get(firstSid)!.issueReadProof(token);
    assert.ok(issued.ok);
    proofRefs.set(firstSid, issued.value.verificationRef);
    await requestAppointment(first);
    assert.equal(detailReads, 1);
    assert.match(spoken.get(firstSid)!.at(-1) ?? "", /option one, Friday 2 October.*option two, Saturday 3 October/);
    first.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "10", streamSid: first.streamSid,
      mark: { name: first.output.received[3]!.mark!.name } }));
    await requestAppointment(first, 11, 6, 8);
    assert.equal(detailReads, 2, "one protected reread checks the selected appointment");
    assert.match(spoken.get(firstSid)!.at(-1) ?? "", /Saturday 3 October/);
    assert.equal((spoken.get(firstSid)!.at(-1) ?? "").includes("Friday 2 October"), false);
    first.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "18", streamSid: first.streamSid,
      mark: { name: first.output.received[5]!.mark!.name } }));
    await requestAppointment(first, 19, 8, 15);
    assert.equal(detailReads, 2, "the consumed choice cannot trigger another protected read");
    assert.match(spoken.get(firstSid)!.at(-1) ?? "", /contact the clinic directly/);

    const secondSid = `CA${"4".repeat(32)}`;
    proofRefs.set(secondSid, issued.value.verificationRef);
    const second = await openCall(secondSid, `MZ${"5".repeat(32)}`);
    await requestAppointment(second);
    assert.equal(detailReads, 2, "a second live call cannot borrow the first call's proof");
    assert.equal(JSON.stringify(spoken.get(secondSid)).includes("appointment on"), false);
    assert.equal(JSON.stringify([...spoken.values()]).includes("PRIVATE"), false);
    assert.equal(writes, 0);
    for (const call of [first, second]) {
      const closed = once(call.socket, "close");
      call.socket.close();
      await closed;
      const done = released.get(call.callSid);
      assert.ok(done);
      await done;
      assert.equal((await verified.get(call.callSid)!.issueReadProof(token)).ok, false);
    }
    assert.equal(constructed, 2);
    const canaries = [firstSid, secondSid, callerPhone, startsAt, secondStartsAt,
      "PRIVATE PATIENT CANARY", "PRIVATE NOTE CANARY"].map((value, index) =>
      ({ label: `private_${index}`, value }));
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (server) { const closed = once(server, "close"); server.close(); await closed; }
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}"`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
