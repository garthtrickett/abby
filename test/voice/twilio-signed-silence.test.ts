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
import type { TimerPort } from "../../src/voice/timer.ts";

const accountSid = `AC${"1".repeat(32)}`;
const callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`;
const authToken = "synthetic-twilio-test-token";
const webhookUrl = "https://calls.example.test/twilio/inbound";
const streamUrl = "wss://calls.example.test/twilio/media/";
const now = "2026-09-29T10:00:00.000Z";
const number = "+6125550199";
const scope = { tenantId: "signed-silence", clinicId: "clinic", locationId: "main" };

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(predicate(), "expected signed-call state");
}

test("E2E-070 signed HTTPS and WSS silence retry ends with a normal WebSocket close", { timeout: 20_000 }, async () => {
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore("execute", () => now, async () => ok(true));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "admin")).ok);
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([
    { accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" },
  ]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const silenceTimer: TimerPort = {
    schedule(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    cancel(handle) { timers.delete(handle as number); },
  };
  const fire = () => {
    assert.equal(timers.size, 1);
    const [id, callback] = timers.entries().next().value as [number, () => void];
    timers.delete(id);
    callback();
  };
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [number]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x34), now: () => new Date(now) });
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
    const call = new TwilioConnectedCall({ event: stream.event, sessionId: "session", ledger, intake,
      fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId, receipt.scope,
        ledger, reception, playback, async () => ok({ kind: "handoff", reason: "callerRequested" })),
      transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } },
      synthesis: { async *stream() { yield new Uint8Array(640); } },
      streamStartedAt: stream.streamStartedAt, now: () => now, send, closeTransport: close, silenceTimer,
    });
    return { receive: raw => call.receive(raw), disconnect: () => call.disconnect() };
  } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let socket: WebSocket | undefined;
  try {
    const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: "+6145550101" };
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
    socket.on("message", data => { sent.push(JSON.parse(data.toString()) as Record<string, unknown>); });
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await until(() => sent.length === 2 && timers.size === 1);
    const mark = (index: number, sequenceNumber: number) => socket!.send(JSON.stringify({ event: "mark",
      sequenceNumber: String(sequenceNumber), streamSid,
      mark: { name: (sent[index]?.mark as { name: string }).name } }));
    let priorTimer = nextTimer;
    mark(1, 2);
    await until(() => nextTimer > priorTimer);
    fire();
    await until(() => sent.length === 4);
    priorTimer = nextTimer;
    mark(3, 3);
    await until(() => nextTimer > priorTimer);
    fire();
    await until(() => sent.length === 6);
    const closed = once(socket, "close");
    mark(5, 4);
    const [code] = await closed;
    assert.equal(code, 1000);
    assert.equal(timers.size, 0);
    const state = await ledger.read(callIdFor({ accountRef: accountSid, providerCallRef: callSid }), scope);
    assert.ok(state.ok);
    assert.equal(state.value.terminal?.reason, "sessionClosed");
    assert.equal(state.value.processedTurnIds.length, 0);
  } finally {
    socket?.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
