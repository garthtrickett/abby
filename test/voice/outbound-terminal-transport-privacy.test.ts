// E2E-423: secret-input presence excludes the transport contact queue, even between private phases.
import assert from "node:assert/strict";
import test from "node:test";
import { syntheticSpeech, withApprovedSyntheticVoice } from "../support/approved-voice.ts";
import { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { ClinicPolicyRouter, ReferenceNumberRoutingHost } from "../../src/reference/clinic-number-routing.ts";
import { MemoryPolicyStore } from "../../src/reference/policy-store.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { CallAdmissionService } from "../../src/voice/admission.ts";
import { SharedNumberIntakeService } from "../../src/voice/shared-number-intake.ts";
import { TwilioConnectedCall } from "../../src/voice/twilio-connected-call.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";

for (const collecting of [false, true])
test(`transport with a secret adapter ${collecting ? "collecting" : "between phases"} never copies media into the unconditional-public contact queue`, async () => {
  const now = "2026-09-29T10:00:00.000Z", scope = { tenantId: "terminal-private", clinicId: "clinic", locationId: "main" };
  const accountSid = "AC" + "1".repeat(32), callSid = "CA" + "2".repeat(32), streamSid = "MZ" + "3".repeat(32), number = "+6125550199";
  const ledger = new MemoryLedger(), policy = withApprovedSyntheticVoice(new MemoryPolicyStore("execute", () => now, async () => ok(true)));
  assert.equal((await policy.changeAutomationEnabled(scope, "0", true, "admin")).ok, true);
  const router = new ClinicPolicyRouter(new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber: number, ...scope, routeVersion: "v1" }]), policy);
  const admission = new CallAdmissionService(ledger, router.resolve, () => now, async () => ok(true));
  const intake = new SharedNumberIntakeService(ledger, router, admission, () => now);
  const reception = new TextReception(ledger, policy, new ReferenceClinicHost([], []));
  let blocked = true, observed = 0, accepted = 0;
  const sent: Record<string, unknown>[] = [];
  const call = new TwilioConnectedCall({ event: { key: { accountRef: accountSid, providerCallRef: callSid }, dialedNumber: number, receivedAt: now },
    sessionId: "session", ledger, intake, streamStartedAt: now, now: () => now,
    privateKeypadInput: { claim: () => true, blocked: () => blocked, start: () => { blocked = collecting; return true; }, accept: async () => "pending", stop: () => undefined },
    onPublicContactMedia: () => { observed++; },
    fullFactory: (receipt, id, playback) => new VoiceSession(receipt.callId, id, receipt.scope, ledger, reception, playback, async () => ok({ kind: "clarify" })),
    ...syntheticSpeech({ synthesis: { async *stream() { yield new Uint8Array(640); } }, transcription: { accept: async () => { accepted++; return ok([]); }, flush: async () => ok([]) } }),
    send: raw => { sent.push(JSON.parse(raw)); return "queued"; } });
  try {
    assert.equal((await call.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }))).ok, true);
    assert.equal((await call.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid,
      start: { accountSid, callSid, streamSid, tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } }))).ok, true);
    assert.equal((await call.receive(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid, mark: sent.find(e => e.event === "mark")!.mark }))).ok, true);
    for (let index = 0; index < 2; index++) assert.equal((await call.receive(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid,
      media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20), payload: Buffer.alloc(160, 0x9f).toString("base64") } }))).ok, true);
    assert.equal(observed, 0); assert.equal(accepted, collecting ? 0 : 2);
  } finally { await call.disconnect(); ledger.dispose(); }
});
