import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import twilio from "twilio";
import WebSocket from "ws";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";

const accountSid = `AC${"1".repeat(32)}`;
const callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`;
const authToken = "synthetic-twilio-test-token";
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";
const now = "2026-09-29T10:00:00.000Z";
const number = "+6125550199";
const scope = { tenantId: "signed-voice", clinicId: "clinic", locationId: "main" };

test("E2E-132 local signed Twilio call admits, proves greeting playback, accepts media, and disconnects", async () => {
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore("execute", () => now, async () => ok(true));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "admin")).ok);
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([
    { accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" },
  ]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, bindingKey: Buffer.alloc(32, 0x34), now: () => new Date(now) });
  let created = 0;
  let playedResolve: (() => void) | undefined;
  let turnResolve: (() => void) | undefined;
  let stoppedResolve: (() => void) | undefined;
  const played = new Promise<void>(resolve => { playedResolve = resolve; });
  const turn = new Promise<void>(resolve => { turnResolve = resolve; });
  const stopped = new Promise<void>(resolve => { stoppedResolve = resolve; });
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send) {
    created += 1;
    assert.equal(stream.event.presentedCallerNumber, "+6145550101");
    const call = new TwilioConnectedCall({ event: stream.event, sessionId: "session", ledger, intake,
      fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId, receipt.scope,
        ledger, reception, playback, async () => ok({ kind: "handoff", reason: "callerRequested" })),
      transcription: {
        async accept() { return ok([]); },
        async flush(generation) { return ok([{ kind: "segmentFinal", sessionId: "session", generation,
          utteranceId: "one", text: "Please speak with staff", quality: "clear" }]); },
      },
      synthesis: { async *stream() { yield new Uint8Array(640); } },
      mediaOptions: { silenceMs: 100 }, streamStartedAt: stream.streamStartedAt, now: () => now, send,
    });
    return { async receive(raw: string) {
      const result = await call.receive(raw);
      if (result.ok && result.value.kind === "played") playedResolve?.();
      if (result.ok && result.value.kind === "media" && result.value.value.kind === "turnCompleted") turnResolve?.();
      if (result.ok && result.value.kind === "stopped") stoppedResolve?.();
      return result;
    }, disconnect: () => call.disconnect() };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let socket: WebSocket | undefined;
  try {
    const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: "+6145550101" };
    const response = await fetch(`${base}/twilio/inbound`, { method: "POST", headers: {
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
    const greeting = new Promise<void>(resolve => socket!.on("message", data => {
      sent.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (sent.length === 2) resolve();
    }));
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await greeting;
    assert.equal(created, 1);
    assert.deepEqual(sent.slice(0, 2).map(message => message.event), ["media", "mark"]);
    const callId = callIdFor({ accountRef: accountSid, providerCallRef: callSid });
    const before = await ledger.read(callId, scope);
    assert.ok(before.ok);
    assert.equal(Object.values(before.value.presentations)[0]?.status, "started");
    socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
      mark: { name: (sent[1]?.mark as { name: string }).name } }));
    await played;
    const after = await ledger.read(callId, scope);
    assert.ok(after.ok);
    assert.equal(Object.values(after.value.presentations)[0]?.status, "played");
    for (let index = 0; index < 7; index += 1) socket.send(JSON.stringify({ event: "media",
      sequenceNumber: String(index + 3), streamSid, media: { track: "inbound", chunk: String(index + 1),
        timestamp: String(index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
    await turn;
    const handled = await ledger.read(callId, scope);
    assert.ok(handled.ok);
    assert.equal(handled.value.processedTurnIds.length, 1);
    socket.send(JSON.stringify({ event: "stop", sequenceNumber: "10", streamSid, stop: { accountSid, callSid } }));
    await stopped;
    const ended = await ledger.read(callId, scope);
    assert.ok(ended.ok);
    assert.equal(ended.value.lifecycle, "ended");
  } finally {
    socket?.terminate();
    server.close();
    await once(server, "close");
  }
});
