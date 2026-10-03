import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import twilio from "twilio";
import WebSocket from "ws";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { createEmbeddedTwilioVoiceComposition } from "../../src/reference/embedded-voice-composition.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";

test("E2E-149 buyer host mounts signed voice and speaks provisional diary times in its process",
  { timeout: 15_000 }, async () => {
  const accountSid = `AC${"4".repeat(32)}`;
  const callSid = `CA${"5".repeat(32)}`;
  const streamSid = `MZ${"6".repeat(32)}`;
  const authToken = "synthetic-embedded-token";
  const webhookUrl = "https://buyer.example.test/twilio/inbound";
  const streamUrl = "wss://buyer.example.test/twilio/media/";
  const now = "2026-09-29T10:00:00.000Z";
  const dialedNumber = "+6125550199";
  const scope = { tenantId: "buyer", clinicId: "clinic", locationId: "main" };
  const ledger = new MemoryLedger();
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "buyer-admin")).ok);
  const host = new ReferenceClinicHost([], []);
  const routing = new ReferenceNumberRoutingHost([{ ...scope, accountRef: accountSid,
    dialedNumber, routeVersion: "buyer-route-v1" }]);
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [dialedNumber]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x36), now: () => new Date(now) });
  const reads: Array<{ scope: typeof scope; from: string; to: string }> = [];
  let created = 0;
  let playedCount = 0;
  let resolveGreeting!: () => void;
  let resolveNotice!: () => void;
  let resolveTurn!: () => void;
  const greetingPlayed = new Promise<void>(resolve => { resolveGreeting = resolve; });
  const noticePlayed = new Promise<void>(resolve => { resolveNotice = resolve; });
  const turnCompleted = new Promise<void>(resolve => { resolveTurn = resolve; });
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
    created += 1;
    const call = createEmbeddedTwilioVoiceComposition({ event: stream.event, sessionId: "buyer-session",
      streamStartedAt: stream.streamStartedAt, send, closeTransport: close, ledger, policy, routing,
      host, readiness: async () => ok(true), now: () => now,
      availability: { async list(readScope, from, to) {
        reads.push({ scope: readScope, from, to });
        return ok({ kind: "times", scope: readScope, sourceRef: "buyer:diary", timeZone: "Australia/Sydney",
          observedAt: now, startsAt: ["2026-09-30T23:00:00.000Z"], reservable: false });
      } },
      resolveIntent: async () => ok({ kind: "availability", from: "2026-10-01", to: "2026-10-02" }),
      ...syntheticSpeech({ synthesis: { async *stream() { yield new Uint8Array(640); } }, transcription: { async accept() { return ok([]); }, async flush(generation) {
        return ok([{ kind: "segmentFinal", sessionId: "buyer-session", generation,
          utteranceId: "caller-one", text: "What times are available?", quality: "clear" }]);
      } } }),

      mediaOptions: { silenceMs: 100 },
    });
    return { async receive(raw: string) {
      const result = await call.receive(raw);
      if (result.ok && result.value.kind === "played") {
        playedCount += 1;
        if (playedCount === 1) resolveGreeting();
        if (playedCount === 2) resolveNotice();
      }
      if (result.ok && result.value.kind === "media" && result.value.value.kind === "turnCompleted") resolveTurn();
      return result;
    }, disconnect: () => call.disconnect() };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: WebSocket | undefined;
  try {
    const form = { AccountSid: accountSid, CallSid: callSid, To: dialedNumber, From: "+6145550101" };
    const rejected = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "invalid",
    }, body: new URLSearchParams(form).toString() });
    assert.equal(rejected.status, 403);
    assert.equal(created, 0);
    const response = await fetch(`http://127.0.0.1:${address.port}/twilio/inbound`, { method: "POST", headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
    }, body: new URLSearchParams(form).toString() });
    assert.equal(response.status, 200);
    const binding = (await response.text()).match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/twilio/media/`, { headers: {
      "x-twilio-signature": twilio.getExpectedTwilioSignature(authToken, streamUrl, {}),
    } });
    await once(socket, "open");
    const sent: Record<string, unknown>[] = [];
    let resolveFirstOutput!: () => void;
    let resolveSecondOutput!: () => void;
    const firstOutput = new Promise<void>(resolve => { resolveFirstOutput = resolve; });
    const secondOutput = new Promise<void>(resolve => { resolveSecondOutput = resolve; });
    socket.on("message", data => {
      sent.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (sent.length === 2) resolveFirstOutput();
      if (sent.length === 4) resolveSecondOutput();
    });
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await firstOutput;
    assert.equal(created, 1);
    assert.deepEqual(sent.map(message => message.event), ["media", "mark"]);
    socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: (sent[1]?.mark as { name: string }).name } }));
    await greetingPlayed;
    for (let index = 0; index < 7; index += 1) socket.send(JSON.stringify({ event: "media",
      sequenceNumber: String(index + 3), streamSid, media: { track: "inbound", chunk: String(index + 1),
        timestamp: String(index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
    await turnCompleted;
    await secondOutput;
    assert.deepEqual(sent.map(message => message.event), ["media", "mark", "media", "mark"]);
    assert.deepEqual(reads, [{ scope, from: "2026-10-01", to: "2026-10-02" }]);
    const callId = callIdFor({ accountRef: accountSid, providerCallRef: callSid });
    const before = await ledger.read(callId, scope);
    assert.ok(before.ok);
    assert.equal(before.value.availabilityReads[0]?.status, "shown");
    assert.deepEqual(before.value.availabilityReads[0]?.shownStartsAt, ["2026-09-30T23:00:00.000Z"]);
    assert.match(before.value.callerMessages.at(-1) ?? "", /can't reserve or confirm/);
    assert.equal(Object.keys(before.value.actions).length, 0);
    assert.equal(Object.keys(before.value.staffItems).length, 0);
    assert.equal(host.bookings(scope).length, 0);
    socket.send(JSON.stringify({ event: "mark", sequenceNumber: "10", streamSid,
      mark: { name: (sent[3]?.mark as { name: string }).name } }));
    await noticePlayed;
    const after = await ledger.read(callId, scope);
    assert.ok(after.ok);
    assert.equal(Object.values(after.value.presentations).some(item => item.kind === "notice" && item.status === "played"), true);
  } finally {
    socket?.terminate();
    server.close();
    await once(server, "close");
  }
});
