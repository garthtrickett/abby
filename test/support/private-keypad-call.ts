import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { ClinikoAppointmentReader } from "../../src/cliniko/appointments.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallerVerificationSession, verificationPrompt } from "../../src/standalone/caller-verification-session.ts";
import { DisabledStandaloneHost } from "../../src/standalone/disabled-host.ts";
import { PrivateKeypadVerification } from "../../src/standalone/private-keypad-verification.ts";
import { CallAdmissionService, callIdFor } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import type { TwilioConnectedCallConfig } from "../../src/voice/twilio-connected-call.ts";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { approvedSyntheticPolicy, syntheticSpeech } from "./approved-voice.ts";
import { callerVerificationFixture, verificationNow } from "./caller-verification.ts";

export async function privateKeypadCallFixture(options: Parameters<typeof callerVerificationFixture>[0] & { privateMode?: boolean; wrapPrivateInput?: (input: import("../../src/voice/private-keypad-input.ts").PrivateKeypadInput) => import("../../src/voice/private-keypad-input.ts").PrivateKeypadInput } = {}) {
  let resolveMail!: () => void;
  const delivered = new Promise<void>(resolve => { resolveMail = resolve; });
  const mail: { email: string; code: string }[] = [];
  const f = await callerVerificationFixture({ ...options, delivery: { async send(email, code, signal) {
    mail.push({ email, code }); resolveMail();
    return options.delivery ? options.delivery.send(email, code, signal) : true;
  } } });
  const accountSid = `AC${"1".repeat(32)}`, callSid = `CA${randomUUID().replaceAll("-", "")}`, streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
  const webhookUrl = "https://keypad.example.test/twilio/inbound", streamUrl = "wss://keypad.example.test/twilio/media/", authToken = "synthetic-private-keypad-token";
  const ingress = new TwilioSignedIngress({ accountSid, authToken, publicWebhookUrl: webhookUrl, publicStreamUrl: streamUrl,
    fallbackNumbers: { [f.inbound.dialedNumber]: "+6125550188" }, bindingKey: Buffer.alloc(32, 0x37), now: () => new Date(verificationNow) });
  const form = { AccountSid: accountSid, CallSid: callSid, To: f.inbound.dialedNumber, From: f.inbound.presentedCallerNumber! };
  const webhook = { method: "POST", requestTarget: "/twilio/inbound", contentType: "application/x-www-form-urlencoded",
    signature: twilio.getExpectedTwilioSignature(authToken, webhookUrl, form), body: new URLSearchParams(form).toString() };
  const answered = ingress.answerWebhook(webhook); assert.ok(answered.ok);
  const binding = answered.value.match(/<Parameter name="abbyBinding" value="([^"]+)"\/>/)?.[1]; assert.ok(binding);
  const connected = JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" });
  const start = JSON.stringify({ event: "start", sequenceNumber: "1", streamSid, start: { accountSid, callSid, streamSid,
    tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { abbyBinding: binding } } });
  const upgrade = { method: "GET", requestTarget: "/twilio/media/", signature: twilio.getExpectedTwilioSignature(authToken, streamUrl, {}), connected, start };
  const authenticated = ingress.authenticateStream(upgrade); assert.ok(authenticated.ok);
  const event = authenticated.value.event, callId = callIdFor(event.key), sessionId = `keypad-${randomUUID()}`;
  const ledger = new MemoryLedger(async () => ok(true));
  const policies = new Proxy(f.policies, { get(target, key) {
    if (key === "read") return async (...args: Parameters<typeof f.policies.read>) => {
      const loaded = await target.read(...args);
      return loaded.ok ? ok(approvedSyntheticPolicy({ ...loaded.value, greeting: { scope: f.scope, version: "private-keypad-prompt",
        approvedText: options.privateMode === false ? "Welcome to the clinic." : `${verificationPrompt} Use six keypad digits, then press pound. Star clears the current entry.`, ownerRef: "synthetic-admin",
        approved: true, effectiveFrom: "2026-10-04T00:00:00.000Z", effectiveUntil: "2026-10-05T00:00:00.000Z" } })) : loaded;
    }
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber: event.dialedNumber,
    ...f.scope, routeVersion: "private-keypad" }]), policies);
  const admission = new CallAdmissionService(ledger, router.resolve, () => verificationNow, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => verificationNow);
  const sent: Record<string, unknown>[] = [], spoken: string[] = [], transcripts: unknown[] = [], modelTurns: unknown[] = [];
  let owner: CallerVerificationSession | undefined, detailReads = 0, normalKeys = 0;
  const privateInput = new PrivateKeypadVerification({ callId, sessionId, owner: () => owner });
  const callConfig: TwilioConnectedCallConfig = { event, streamStartedAt: verificationNow, sessionId, ledger, intake,
    ...(options.privateMode === false ? {} : { privateKeypadInput: options.wrapPrivateInput?.(privateInput) ?? privateInput }),
    onCallStop: () => owner?.dispose(),
    keypadAvailabilityRange: () => { normalKeys++; return null; },
    fullFactory(receipt, actualSessionId, playback) {
      const created = CallerVerificationSession.create({ ...f.sessionConfig, receipt, inbound: event, sessionId: actualSessionId, ledger, policyStore: policies });
      assert.ok(created.ok); owner = created.value;
      const reader = ClinikoAppointmentReader.create({ scope: f.scope, apiKey: "synthetic-session-au5", contactEmail: "owner@example.test", businessId: "11" },
        owner.proof, async input => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/businesses/11") return Response.json({ id: "11", archived_at: null, time_zone_identifier: "Australia/Sydney" });
          assert.equal(path, "/v1/individual_appointments"); detailReads++; return Response.json({ total_entries: 0, individual_appointments: [] });
        }, () => verificationNow); assert.ok(reader.ok);
      const reception = new TextReception(ledger, policies, new DisabledStandaloneHost(), undefined, reader.value);
      return new VoiceSession(receipt.callId, actualSessionId, receipt.scope, ledger, reception, playback, async turn => {
        modelTurns.push(structuredClone(turn));
        const grant = await owner!.verified();
        return ok({ kind: "appointments", verificationRef: grant?.verificationRef ?? "unverified", from: verificationNow, to: "2026-10-05T06:00:00.000Z" });
      });
    },
    ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } }, transcription: {
      async accept(frame) { transcripts.push({ sequence: frame.sequence }); return ok([]); },
      async flush(generation) { transcripts.push({ generation }); return ok([{ kind: "segmentFinal", sessionId, generation,
        utteranceId: "ordinary-read", text: "Read my appointments", quality: "clear" }]); },
    } }), mediaOptions: { silenceMs: 100 }, now: () => verificationNow,
    send(json) { sent.push(JSON.parse(json) as Record<string, unknown>); return "queued"; },
  };
  const call = new TwilioConnectedCall(callConfig);
  let wireSequence = 1, chunk = 0, timestampOffset = 0;
  const receive = (message: Record<string, unknown>) => call.receive(JSON.stringify({ ...message, streamSid, sequenceNumber: String(++wireSequence) }));
  return { f, ledger, call, callConfig, mail, delivered, privateInput, callId, sessionId, sent, spoken, transcripts, modelTurns, ingress, webhook, upgrade,
    get owner() { assert.ok(owner); return owner; }, get detailReads() { return detailReads; }, get normalKeys() { return normalKeys; },
    async start() { assert.ok((await call.receive(connected)).ok); assert.ok((await call.receive(start)).ok); },
    mark() { const marker = sent.find(value => value.event === "mark")?.mark as { name: string }; assert.ok(marker);
      return receive({ event: "mark", mark: { name: marker.name } }); },
    digit(digit: string) { return receive({ event: "dtmf", dtmf: { track: "inbound_track", digit } }); },
    async code(code: string) { for (const digit of `${code}#`) { const result = await receive({ event: "dtmf", dtmf: { track: "inbound_track", digit } }); if (!result.ok) return result; }
      return ok({ kind: "privateInput" as const }); },
    media(voiced = true, gapMs = 0) { const current = chunk++; timestampOffset += gapMs; return receive({ event: "media", media: { track: "inbound", chunk: String(current + 1), timestamp: String(current * 20 + timestampOffset),
      payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } }); },
    async resume() {
      for (let i = 0; i < 25; i++) {
        const current = chunk++;
        const discarded = await receive({ event: "media", media: { track: "inbound", chunk: String(current + 1), timestamp: String(current * 20 + timestampOffset),
          payload: Buffer.alloc(160, 0xff).toString("base64") } });
        assert.deepEqual(discarded, { ok: true, value: { kind: "privateInput" } });
      }
    },
    receive,
    async close() { try { await call.disconnect(); } finally { owner?.dispose(); await f.close(); } },
  };
}
