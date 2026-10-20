import assert from "node:assert/strict";
import { once } from "node:events";
import { ok } from "../../src/core/model.ts";
import type { MemoryLedger } from "../../src/core/ledger.ts";
import type { ClinikoRequestBudget } from "../../src/cliniko/read-budget.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { ClinikoOutboundAppointmentTarget } from "../../src/cliniko/outbound-appointment-target.ts";
import { encodeOutboundRecipientRequest } from "../../src/cliniko/outbound-recipient-request.ts";
import { callIdFor } from "../../src/voice/admission.ts";
import { outboundConversationProfileRef } from "../../src/voice/outbound-voice-entry.ts";
import type { OutboundConversationApproval } from "../../src/voice/outbound-voice-entry.ts";
import { twilioAbbyOutboundConversation } from "../../src/standalone/twilio-outbound-conversation.ts";
import { clinikoOutboundVoice } from "../../src/standalone/cliniko-outbound-voice.ts";
import type { ClinikoCallFlow } from "../../src/standalone/cliniko-call-flow.ts";
import type { VoiceIntent } from "../../src/voice/voice-session.ts";
import { approvedSyntheticPolicy, syntheticSpeech } from "./approved-voice.ts";
import { reschedulingSessionFixture } from "./rescheduling-session.ts";
import { outboundRequestValue } from "./outbound-recipient-request.ts";
import { value } from "./outbound-records.ts";
import { verificationCanaries, verificationNow } from "./caller-verification.ts";
import { twilioOutboundIngressFixture } from "./twilio-outbound-ingress.ts";
import { SyntheticPlaybackReceipts } from "./synthetic-playback-receipts.ts";

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!await check()) {
    assert.ok(Date.now() < end, label + " timed out");
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

/** Real signed carrier HTTP/WebSocket, clinical prepared bundle, private keypad,
 * native decoders and ordinary review/write owners. Clinic grants, remote native
 * HTTP, email, clear-final speech recognition and synthesis are synthetic. */
export async function outboundClinicalVoiceFixture(options: Readonly<{ budget?: ClinikoRequestBudget; apiKey?: string; recipientNumber?: string;
  identities?: NonNullable<Parameters<typeof twilioOutboundIngressFixture>[0]>["identities"];
  sessionEffects?: NonNullable<Parameters<typeof twilioOutboundIngressFixture>[0]>["sessionEffects"] }> = {}) {
  const f = await reschedulingSessionFixture({ multiple: true, ...(options.budget ? { rateBudget: options.budget } : {}) });
  f.owner.dispose();
  const lifetime = new AbortController(), c = { ...f.config.cliniko, ...(options.apiKey ? { apiKey: options.apiKey } : {}) }, base = "https://api.au5.cliniko.com/v1";
  if (options.apiKey) {
    await f.replacePolicy({ credentialFingerprint: clinikoCredentialFingerprint(c.apiKey) });
    await f.replaceDestination({ credentialFingerprint: clinikoCredentialFingerprint(c.apiKey) });
  }
  let mediaElapsedMs = 0, nowOffset = 0, notes = "", requestVersion = verificationNow, moved = false, patches = 0;
  let targetVersion = "2026-10-02T00:00:00.000Z", contactNumber = options.recipientNumber ?? "+61481927364", lastTarget: Record<string, unknown> | undefined;
  let ledger: MemoryLedger | undefined, flow: ClinikoCallFlow | undefined, sessionId: string | undefined, actualCallId: string | undefined;
  const now = () => new Date(Date.parse(verificationNow) + nowOffset + mediaElapsedMs).toISOString();
  const nativeCalls: { method: string; path: string }[] = [], spoken: string[] = [], modelTurns: string[] = [], transcripts: string[] = [];
  const state = { originalLive: true, targetLive: true, nativeLive: true, profileLive: true };
  const native: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? "GET"; nativeCalls.push({ method, path: url.pathname });
    if (url.pathname === "/v1/recalls/30" && method === "GET") return Response.json({ id: "30", links: { self: `${base}/recalls/30` },
      patient: { links: { self: `${base}/patients/${verificationCanaries[2]}` } }, recall_type: { links: { self: `${base}/recall_types/61` } },
      notes, recall_at: "2026-10-05", recalled: false, recalled_at: null, archived_at: null, created_at: verificationNow, updated_at: requestVersion });
    if (url.pathname === "/v1/individual_appointments/91" && method === "PATCH") {
      assert.ok(ledger && actualCallId);
      const current = value(await ledger.read(actualCallId, f.scope)), action = Object.values(current.actions)[0]!;
      assert.equal(action.status, "dispatched"); assert.equal(current.presentations[action.presentationId]?.status, "played");
      assert.equal(f.recalls.length, 1); assert.equal(patches, 0);
      assert.deepEqual(JSON.parse(String(init?.body)), { starts_at: "2026-10-08T05:00:00.000Z", ends_at: null });
      assert.ok(lastTarget); patches++; moved = true;
      return Response.json({ ...lastTarget, starts_at: "2026-10-08T05:00:00.000Z", ends_at: "2026-10-08T05:30:00.000Z" });
    }
    const response = await f.ownerPorts.fetchPort(input, init);
    if (url.pathname === `/v1/patients/${verificationCanaries[2]}` && method === "GET" && response.ok)
      return Response.json({ ...await response.json(), patient_phone_numbers: [{ number: contactNumber, phone_type: "Mobile" }] });
    if (url.pathname === "/v1/individual_appointments/91" && method === "GET" && response.ok) {
      lastTarget = { ...await response.json(), ...(moved ? { starts_at: "2026-10-08T05:00:00.000Z", ends_at: "2026-10-08T05:30:00.000Z" } : {}),
        links: { self: `${base}/individual_appointments/91` }, created_at: "2026-10-01T00:00:00.000Z", updated_at: targetVersion,
        did_not_arrive: null, patient_arrived: false };
      return Response.json(lastTarget);
    }
    return response;
  };
  const requests = { scope: f.scope, apiKey: c.apiKey, contactEmail: c.contactEmail, businessId: c.businessId,
    outboundRecallTypeId: "61", recordPolicyDigest: "d".repeat(64), rateBudget: c.rateBudget, clock: now };
  const target = { appointmentPolicyDigest: "e".repeat(64), authority: { allows: async () => true, current: () => state.targetLive } };
  const observed = value(await value(ClinikoOutboundAppointmentTarget.create({ requests, appointmentPolicyDigest: target.appointmentPolicyDigest }, target.authority, native))
    .observeTarget({ patientId: verificationCanaries[2]!, appointmentRef: "cliniko:appointment:91" }, lifetime.signal));
  const request = { ...outboundRequestValue(), scope: f.scope, businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey),
    patientId: verificationCanaries[2]!, purpose: "sickDay" as const, recipient: { kind: "voice" as const, number: contactNumber },
    appointment: { ref: observed.target.appointmentRef, digest: observed.digest }, requestedAt: verificationNow,
    schedule: { notBefore: verificationNow, expiresAt: "2026-10-09T06:00:00.000Z", timeZone: "Australia/Sydney", weekdays: [1, 2, 3, 4, 5, 6, 7], opensAt: "00:00", closesAt: "23:59" } };
  notes = value(encodeOutboundRecipientRequest(request));
  const basePolicy = value(await f.policies.read(f.scope));
  const greeting = { scope: f.scope, version: "outbound-clinical-v1", ownerRef: "clinic-owner", approved: true as const,
    approvedText: "Hello, this is Abby calling on behalf of the clinic.", effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-10-10T00:00:00.000Z" };
  const policy = (p: typeof basePolicy) => approvedSyntheticPolicy({ ...p, greeting });
  const policies = new Proxy(f.policies, { get(target, key) {
    if (key === "read") return async (...args: Parameters<typeof target.read>) => { const found = await target.read(...args); return found.ok ? ok(policy(found.value)) : found; };
    const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v;
  } });
  const approval: OutboundConversationApproval = { purpose: "outboundContact", runtimeConfigurationHash: "a".repeat(64),
    mediaOptions: { silenceMs: 100 }, policy: policy(basePolicy) };
  const { inbound: _, representative: __, ...clinical } = f.config;
  const inputs: { text: string; intent: VoiceIntent }[] = [];
  const prepare = clinikoOutboundVoice({ clinical: { ...clinical, cliniko: c, policies, fetchPort: native,
      approvals: { bookCaller: clinical.callerApprovalPath, cancelCaller: clinical.callerApprovalPath, rescheduleCaller: clinical.callerApprovalPath,
        booking: clinical.bookingApprovalPath, cancellation: clinical.reschedulingApprovalPath, rescheduling: clinical.reschedulingApprovalPath } },
    context: { requests, records: { allows: async () => true, current: () => state.nativeLive },
      authority: { allows: async () => true, current: () => state.originalLive }, target },
    greeting, clock: now, intent: selected => { flow = selected; return async turn => {
      modelTurns.push(turn.text); const next = inputs.shift(); assert.ok(next); assert.equal(turn.text, next.text); return ok(next.intent);
    }; } });
  const transport = await twilioOutboundIngressFixture({ request, now, ...(options.identities ? { identities: options.identities } : {}), profileRef: outboundConversationProfileRef(approval)!,
    ...(options.sessionEffects ? { sessionEffects: options.sessionEffects } : {}), conversation: runtime => twilioAbbyOutboundConversation({ runtime,
      source: { read: async () => ok(approval), current: () => state.profileLive }, runtimeConfigurationHash: approval.runtimeConfigurationHash,
      readiness: async () => ok(true), now, mediaOptions: { silenceMs: 100 },
      ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
        transcriptionFactory: id => ({ accept: async () => ok([]), flush: async generation => {
          const next = inputs[0]; assert.ok(next, "No ordinary speech queued; private audio must never reach recognition"); transcripts.push(next.text);
          return ok([{ kind: "segmentFinal", sessionId: id, generation, utteranceId: "clinical-" + modelTurns.length, text: next.text, quality: "clear" }]);
        } }) }), prepareSession: async context => { ledger = context.ledger; sessionId = context.sessionId; actualCallId = callIdFor(context.call.key); return prepare(context); } }) });
  const server = await transport.listen();
  let wire: Awaited<ReturnType<typeof server.open>> | undefined, closed = false, sequence = 1, chunk = 0;
  const sent: { event: string; mark?: { name: string } }[] = [];
  const send = (event: object) => wire!.socket.send(JSON.stringify({ ...event, streamSid: transport.streamSid, sequenceNumber: String(++sequence) }));
  const playback = new SyntheticPlaybackReceipts(name => send({ event: "mark", mark: { name } }));
  const barrier = async () => { const done = once(wire!.socket, "pong"); wire!.socket.ping(); await done; };
  const media = (voiced: boolean) => {
    mediaElapsedMs = chunk * 20; chunk++;
    send({ event: "media", media: { track: "inbound", chunk: String(chunk), timestamp: String(mediaElapsedMs), payload: Buffer.alloc(160, voiced ? 0x9f : 0xff).toString("base64") } });
  };
  const current = async () => { assert.ok(ledger && actualCallId); return value(await ledger.read(actualCallId, f.scope)); };
  return { ...f, transport, server, spoken, transcripts, modelTurns, nativeCalls, sent, state, request, requestNotes: notes, recipientNumber: request.recipient.number,
    get patches() { return patches; }, get flow() { assert.ok(flow); return flow; }, get sessionId() { assert.ok(sessionId); return sessionId; },
    get actualCallId() { assert.ok(actualCallId); return actualCallId; }, current,
    changeTarget() { targetVersion = "2026-10-03T00:00:00.000Z"; }, changeRequest() { requestVersion = "2026-10-04T06:00:01.000Z"; },
    changeContact() { contactNumber = "+61481927365"; }, expire() { nowOffset += 300_000; },
    async open() {
      const response = await server.post(); assert.equal(response.status, 200); wire = await server.open(await response.text());
      wire.socket.on("message", raw => { const event = JSON.parse(raw.toString()); sent.push(event); playback.receive(event); });
      wire.socket.once("close", () => { closed = true; });
      assert.equal(await wire.outcome, "ready"); await until(() => playback.hasPendingAfter(), "public greeting");
    },
    async mark() {
      await until(() => playback.hasPendingAfter(), "pending played marker"); assert.equal(playback.acknowledgeLatest(), true);
      await until(async () => !(await current()).pendingPresentationId, "actual played presentation");
    },
    async say(text: string, intent: VoiceIntent) {
      const marks = playback.count; inputs.push({ text, intent }); for (let i = 0; i < 7; i++) media(i < 2);
      await until(() => playback.hasReplyAfter(marks) || closed, "ordinary clinical reply"); assert.equal(closed, false);
    },
    async privateCode(code: string) {
      assert.ok(flow?.verificationRequired);
      const before = transcripts.length;
      for (let i = 0; i < 7; i++) media(i < 2);
      for (const digit of code + "#") send({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await until(() => flow!.verificationRequired === false || closed, "actual private verification"); assert.equal(closed, false);
      assert.equal(transcripts.length, before);
      for (let i = 0; i < 25; i++) media(false); await barrier();
    },
    async rejectPrivateCode(code: string) {
      assert.ok(flow?.verificationRequired);
      for (let attempt = 0; attempt < 3; attempt++)
        for (const digit of code + "#") send({ event: "dtmf", dtmf: { track: "inbound_track", digit } });
      await until(() => closed, "three private failures close actual call", 5000);
    },
    async waitForMail() { await until(() => f.mail.length > 0, "native registered-channel challenge", 5000); return f.mail.at(-1)!.code; },
    close: async () => { lifetime.abort(); await server.close(); await f.close(); } };
}
