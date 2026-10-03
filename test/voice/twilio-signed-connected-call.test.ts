import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
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
const scope = { tenantId: "signed-voice", clinicId: "clinic", locationId: "main" };

test("E2E-132 and E2E-141 signed call renews beyond its first lease and closes the socket on lease loss",
  { timeout: 20_000 }, async () => {
  const startedMs = Date.parse(now);
  let currentMs = startedMs;
  const clock = () => new Date(currentMs).toISOString();
  const pending = new Map<number, () => void>();
  let nextTimer = 0;
  const leaseTimer: TimerPort = {
    schedule(callback) { const handle = ++nextTimer; pending.set(handle, callback); return handle; },
    cancel(handle) { pending.delete(handle as number); },
  };
  const fireLeaseTimer = () => {
    const [handle, callback] = pending.entries().next().value as [number, () => void];
    pending.delete(handle);
    callback();
  };
  const ledger = new MemoryLedger();
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "admin")).ok);
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([
    { accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" },
  ]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, clock, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, clock);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [number]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x34), now: () => new Date(now) });
  let created = 0;
  let playedResolve: (() => void) | undefined;
  let turnResolve: (() => void) | undefined;
  let renewalResolve!: (kind: string) => void;
  const renewal = new Promise<string>(resolve => { renewalResolve = resolve; });
  let leaseLostResolve!: (kind: string) => void;
  const leaseLost = new Promise<string>(resolve => { leaseLostResolve = resolve; });
  const played = new Promise<void>(resolve => { playedResolve = resolve; });
  const turn = new Promise<void>(resolve => { turnResolve = resolve; });
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
    created += 1;
    assert.equal(stream.event.presentedCallerNumber, "+6145550101");
    const call = new TwilioConnectedCall({ event: stream.event, sessionId: "session", ledger, intake,
      fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId, receipt.scope,
        ledger, reception, playback, async () => ok({ kind: "handoff", reason: "callerRequested" })),
      ...syntheticSpeech({ synthesis: { async *stream() { yield new Uint8Array(640); } }, transcription: {
        async accept() { return ok([]); },
        async flush(generation) { return ok([{ kind: "segmentFinal", sessionId: "session", generation,
          utteranceId: "one", text: "Please speak with staff", quality: "clear" }]); },
      } }),

      mediaOptions: { silenceMs: 100 }, streamStartedAt: stream.streamStartedAt,
      now: clock, send, leaseTimer, closeTransport: close,
      onLeaseAttempt: outcome => {
        const kind = outcome.kind === "renewed" ? "renewed" : outcome.reason;
        if (kind === "renewed") renewalResolve(kind);
        if (kind === "leaseLost") leaseLostResolve(kind);
      },
    });
    return { async receive(raw: string) {
      const result = await call.receive(raw);
      if (result.ok && result.value.kind === "played") playedResolve?.();
      if (result.ok && result.value.kind === "media" && result.value.value.kind === "turnCompleted") turnResolve?.();
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
    currentMs = startedMs + 20_000;
    fireLeaseTimer();
    assert.equal(await renewal, "renewed");
    const extended = await ledger.read(callId, scope);
    assert.ok(extended.ok);
    assert.equal(extended.value.sessionLease?.version, 2);
    assert.equal(extended.value.sessionLease?.expiresAt, new Date(startedMs + 50_000).toISOString());
    currentMs = startedMs + 35_000;
    for (let index = 0; index < 7; index += 1) socket.send(JSON.stringify({ event: "media",
      sequenceNumber: String(index + 3), streamSid, media: { track: "inbound", chunk: String(index + 1),
        timestamp: String(35_000 + index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
    await turn;
    const handled = await ledger.read(callId, scope);
    assert.ok(handled.ok);
    assert.equal(handled.value.processedTurnIds.length, 1);
    const closed = once(socket, "close");
    currentMs = startedMs + 60_000;
    fireLeaseTimer();
    assert.equal(await leaseLost, "leaseLost");
    assert.equal((await closed)[0], 1008);
    assert.equal(pending.size, 0);
  } finally {
    socket?.terminate();
    server.close();
    await once(server, "close");
  }
});

test("E2E-142 caller speech clears a signed socket greeting without deadlocking its fence", { timeout: 10_000 },
  async () => {
  const ledger = new MemoryLedger();
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  assert.ok((await policy.changeAutomationEnabled(scope, "0", true, "admin")).ok);
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([
    { accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" },
  ]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [number]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x35), now: () => new Date(now) });
  let speakingResolve!: () => void;
  const speaking = new Promise<void>(resolve => { speakingResolve = resolve; });
  const server = createTwilioIngressServer({ ingress, async createCall(stream, send, close) {
    const call = new TwilioConnectedCall({ event: stream.event, sessionId: "session", ledger, intake,
      fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId, receipt.scope,
        ledger, reception, playback, async () => ok({ kind: "handoff", reason: "callerRequested" })),
      ...syntheticSpeech({ synthesis: { async *stream() { yield new Uint8Array(640); } }, transcription: { async accept() { return ok([]); }, async flush() { return ok([]); } } }),

      streamStartedAt: stream.streamStartedAt, now: () => now, send, closeTransport: close,
    });
    return { async receive(raw: string) {
      const result = await call.receive(raw);
      if (result.ok && result.value.kind === "media" && result.value.value.kind === "speaking") speakingResolve();
      return result;
    }, disconnect: () => call.disconnect() };
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
    let greetingResolve!: () => void;
    let fenceResolve!: () => void;
    const greeting = new Promise<void>(resolve => { greetingResolve = resolve; });
    const fence = new Promise<void>(resolve => { fenceResolve = resolve; });
    socket.on("message", data => {
      sent.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (sent.length === 2) greetingResolve();
      if (sent.some(message => message.event === "clear")) fenceResolve();
    });
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } }));
    await greeting;
    assert.deepEqual(sent.map(message => message.event), ["media", "mark"]);
    for (let index = 0; index < 2; index += 1) socket.send(JSON.stringify({ event: "media",
      sequenceNumber: String(index + 2), streamSid, media: { track: "inbound", chunk: String(index + 1),
        timestamp: String(index * 20), payload: Buffer.alloc(160, 0x9f).toString("base64") } }));
    await fence;
    assert.deepEqual(sent.map(message => message.event), ["media", "mark", "mark", "clear"]);
    const completionName = (sent[1]?.mark as { name: string }).name;
    const fenceName = (sent[2]?.mark as { name: string }).name;
    socket.send(JSON.stringify({ event: "mark", sequenceNumber: "4", streamSid,
      mark: { name: completionName } }));
    socket.send(JSON.stringify({ event: "mark", sequenceNumber: "5", streamSid,
      mark: { name: fenceName } }));
    await speaking;
    const state = await ledger.read(callIdFor({ accountRef: accountSid, providerCallRef: callSid }), scope);
    assert.ok(state.ok);
    assert.equal(Object.values(state.value.presentations)[0]?.status, "interrupted");
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally {
    socket?.terminate();
    server.close();
    await once(server, "close");
  }
});
