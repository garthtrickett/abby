import assert from "node:assert/strict";
import test from "node:test";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";

const accountSid = `AC${"1".repeat(32)}`;
const callSid = `CA${"2".repeat(32)}`;
const streamSid = `MZ${"3".repeat(32)}`;
const now = "2026-09-29T10:00:00.000Z";
const scope = { tenantId: "twilio-tenant", clinicId: "twilio-clinic", locationId: "main" };

test("E2E-130 synthetic Twilio: ordered wire events start the call, prove greeting playback, deliver caller media and disconnect", async () => {
  const ledger = new MemoryLedger();
  const policy = new MemoryPolicyStore("execute", () => now, async () => ok(true));
  const enabled = await policy.changeAutomationEnabled(scope, "0", true, "admin");
  assert.ok(enabled.ok);
  const number = "+6125550199";
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([
    { accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" },
  ]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const event = { key: { accountRef: accountSid, providerCallRef: callSid }, dialedNumber: number, receivedAt: now };
  const sent: Record<string, unknown>[] = [];
  const call = new TwilioConnectedCall({ event, sessionId: "session", ledger, intake,
    fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId, receipt.scope,
      ledger, reception, playback, async () => ok({ kind: "handoff", reason: "callerRequested" })),
    transcription: {
      async accept() { return ok([]); },
      async flush(generation) { return ok([{ kind: "segmentFinal", sessionId: "session", generation,
        utteranceId: "one", text: "Please speak with staff", quality: "clear" }]); },
    },
    synthesis: { async *stream() { yield new Uint8Array(640); } },
    mediaOptions: { silenceMs: 100 },
    streamStartedAt: now, now: () => now,
    send(json) { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued"; },
  });
  const connected = await call.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  assert.ok(connected.ok && connected.value.kind === "connected");
  const started = await call.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
    start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: {
      encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1,
    } } }));
  assert.ok(started.ok && started.value.kind === "started");
  if (!started.ok || started.value.kind !== "started" || started.value.value.kind !== "admitted") return;
  const greeting = started.value.value.delivery;
  assert.equal(greeting.kind, "queued");
  assert.deepEqual(sent.map(message => message.event), ["media", "mark"]);
  const callId = callIdFor(event.key);
  const before = await ledger.read(callId, scope);
  assert.ok(before.ok);
  assert.equal(Object.values(before.value.presentations)[0]?.status, "started");
  const marker = (sent[1]?.mark as { name: string }).name;
  const played = await call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid,
    mark: { name: marker } }));
  assert.ok(played.ok && played.value.kind === "played");
  const after = await ledger.read(callId, scope);
  assert.ok(after.ok);
  assert.equal(Object.values(after.value.presentations)[0]?.status, "played");

  for (let index = 0; index < 7; index += 1) {
    const incoming = await call.receive(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid,
      media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20),
        payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
    assert.ok(incoming.ok, incoming.ok ? "" : incoming.error.kind);
    assert.equal(incoming.value.kind, "media");
    if (index === 6 && incoming.value.kind === "media") assert.equal(incoming.value.value.kind, "turnCompleted");
  }
  const handled = await ledger.read(callId, scope);
  assert.ok(handled.ok);
  assert.equal(handled.value.processedTurnIds.length, 1);
  assert.ok(handled.value.conversationRevision > 0);
  const stopped = await call.receive(JSON.stringify({ event: "stop", sequenceNumber: "10", streamSid,
    stop: { accountSid, callSid } }));
  assert.ok(stopped.ok && stopped.value.kind === "stopped");
  const ended = await ledger.read(callId, scope);
  assert.ok(ended.ok);
  assert.equal(ended.value.lifecycle, "ended");
});
