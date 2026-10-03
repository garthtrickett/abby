import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import assert from "node:assert/strict";
import test from "node:test";
import twilio from "twilio";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { err, ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";

test("E2E-018 signed synthetic calls respect automation default, on, off, invalid, and failed readiness", async () => {
  const scope = { tenantId: "automation-e2e", clinicId: "clinic", locationId: "main" };
  const accountSid = `AC${"1".repeat(32)}`;
  const authToken = "synthetic-twilio-token";
  const number = "+6125550199";
  const now = "2026-09-29T10:00:00.000Z";
  const webhookUrl = "https://calls.example.test/twilio/inbound";
  const streamUrl = "wss://calls.example.test/twilio/media/";
  let ready = true;
  const readiness = async () => ready ? ok(true as const) :
    err({ kind: "readinessFailed" as const, missing: ["mediaTestCall"] as const });
  const ledger = new MemoryLedger();
  const policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, readiness));
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([
    { accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" },
  ]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, readiness);
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl,
    publicStreamUrl: streamUrl, fallbackNumbers: { [number]: "+6125550188" },
    bindingKey: Buffer.alloc(32, 0x34), now: () => new Date(now) });

  function signedCall(index: number) {
    const callSid = `CA${String(index).padStart(32, "0")}`;
    const streamSid = `MZ${String(index).padStart(32, "0")}`;
    const form = { AccountSid: accountSid, CallSid: callSid, To: number, From: "+6145550101" };
    const webhook = ingress.answerWebhook({ method: "POST", requestTarget: "/twilio/inbound",
      contentType: "application/x-www-form-urlencoded",
      signature: twilio.getExpectedTwilioSignature(authToken, webhookUrl, form),
      body: new URLSearchParams(form).toString() });
    assert.ok(webhook.ok);
    assert.match(webhook.value, /<Connect><Stream/);
    const binding = webhook.value.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1];
    assert.ok(binding);
    const connected = JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" });
    const start = JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"],
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        customParameters: { abbyBinding: binding } } });
    const authenticated = ingress.authenticateStream({ method: "GET", requestTarget: "/twilio/media/",
      signature: twilio.getExpectedTwilioSignature(authToken, streamUrl, {}), connected, start });
    assert.ok(authenticated.ok);
    const sent: Record<string, unknown>[] = [];
    const spoken: string[] = [];
    const call = new TwilioConnectedCall({ event: authenticated.value.event,
      streamStartedAt: authenticated.value.streamStartedAt, sessionId: `session-${index}`,
      ledger, intake, now: () => now,
      fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId,
        receipt.scope, ledger, reception, playback,
        async () => ok({ kind: "handoff", reason: "callerRequested" })),
      ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } }, transcription: {
        async accept() { return ok([]); },
        async flush(generation) { return ok([{ kind: "segmentFinal", sessionId: `session-${index}`,
          generation, utteranceId: "staff-request", text: "Please speak with staff", quality: "clear" }]); },
      } }),

      mediaOptions: { silenceMs: 100 },
      send(json) { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued" as const; },
    });
    return { call, connected, start, streamSid, callSid, sent, spoken };
  }

  async function startCase(index: number) {
    const fixture = signedCall(index);
    assert.deepEqual(await fixture.call.receive(fixture.connected), { ok: true, value: { kind: "connected" } });
    return { ...fixture, result: await fixture.call.receive(fixture.start) };
  }

  const defaultOff = await startCase(1);
  assert.deepEqual(defaultOff.result, { ok: false, error: { kind: "automationDisabled" } });
  assert.deepEqual(defaultOff.sent, []);
  assert.deepEqual(defaultOff.spoken, []);
  assert.deepEqual(await ledger.findAdmission(callIdFor({ accountRef: accountSid, providerCallRef: defaultOff.callSid })),
    { ok: true, value: null });

  const enabled = await policy.changeAutomationEnabled(scope, "0", true, "clinic-admin");
  assert.ok(enabled.ok);
  assert.equal(enabled.value.automationVersion, "1");
  const active = await startCase(2);
  assert.ok(active.result.ok);
  assert.equal(active.result.value.kind, "started");
  assert.deepEqual(active.sent.map(message => message.event), ["media", "mark"]);
  assert.deepEqual(active.spoken, ["Hello. How can I help you?"]);
  const activeId = callIdFor({ accountRef: accountSid, providerCallRef: active.callSid });
  const admitted = await ledger.read(activeId, scope);
  assert.ok(admitted.ok);
  assert.equal(admitted.value.policy.automationEnabled, true);

  const invalid = await policy.changeAutomationEnabled(scope, "1", "false" as unknown as boolean, "clinic-admin");
  assert.deepEqual(invalid, { ok: false, error: { kind: "invalidValue" } });
  assert.equal((await policy.read(scope)).ok, true);
  const disabled = await policy.changeAutomationEnabled(scope, "1", false, "clinic-admin");
  assert.ok(disabled.ok);
  assert.equal(disabled.value.automationVersion, "2");

  const mark = (active.sent[1]?.mark as { name: string }).name;
  const played = await active.call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2",
    streamSid: active.streamSid, mark: { name: mark } }));
  assert.ok(played.ok);
  assert.equal(played.value.kind, "played");
  for (let frame = 0; frame < 7; frame += 1) {
    const progressed = await active.call.receive(JSON.stringify({ event: "media",
      sequenceNumber: String(frame + 3), streamSid: active.streamSid,
      media: { track: "inbound", chunk: String(frame + 1), timestamp: String(frame * 20),
        payload: Buffer.alloc(160, frame < 2 ? 0x9f : 0xff).toString("base64") } }));
    assert.ok(progressed.ok);
  }
  const continued = await ledger.read(activeId, scope);
  assert.ok(continued.ok);
  assert.equal(continued.value.policy.automationEnabled, true);
  assert.equal(continued.value.processedTurnIds.length, 1);
  assert.equal(Object.keys(continued.value.staffItems).length, 1);
  assert.ok(active.spoken.some(text => text.includes("staff follow-up")));
  assert.ok(active.spoken.some(text => text.includes("can't confirm")));
  assert.ok(active.spoken.every(text => !text.includes("booked")));
  await active.call.disconnect();

  const newOff = await startCase(3);
  assert.deepEqual(newOff.result, { ok: false, error: { kind: "automationDisabled" } });
  assert.deepEqual(newOff.sent, []);
  assert.deepEqual(newOff.spoken, []);
  assert.deepEqual(await ledger.findAdmission(callIdFor({ accountRef: accountSid, providerCallRef: newOff.callSid })),
    { ok: true, value: null });

  assert.ok((await policy.changeAutomationEnabled(scope, "2", true, "clinic-admin")).ok);
  ready = false;
  const notReady = await startCase(4);
  assert.deepEqual(notReady.result, { ok: false, error: { kind: "readinessFailed" } });
  assert.deepEqual(notReady.sent, []);
  assert.deepEqual(notReady.spoken, []);
  assert.deepEqual(await ledger.findAdmission(callIdFor({ accountRef: accountSid, providerCallRef: notReady.callSid })),
    { ok: true, value: null });
});
