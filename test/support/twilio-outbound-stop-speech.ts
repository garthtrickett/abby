import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getExpectedTwilioSignature } from "twilio/lib/webhooks/webhooks.js";
import type { AdmissionReceipt } from "../../src/core/model.ts";
import type { MemoryLedger } from "../../src/core/ledger.ts";
import { ok } from "../../src/core/model.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { TwilioAbbyOutboundRuntime } from "../../src/voice/twilio-outbound-runtime.ts";
import { TwilioOutboundIngress } from "../../src/voice/twilio-outbound-ingress.ts";
import { TwilioSignedIngress } from "../../src/voice/twilio-signed-ingress.ts";
import { createTwilioIngressServer } from "../../src/voice/twilio-ingress-server.ts";
import { bindOutboundVoiceRuntime } from "../../src/voice/outbound-runtime.ts";
import { outboundConversationProfileRef } from "../../src/voice/outbound-voice-entry.ts";
import type { OutboundConversationApproval } from "../../src/voice/outbound-voice-entry.ts";
import { twilioAbbyOutboundConversation } from "../../src/standalone/twilio-outbound-conversation.ts";
import { TwilioOutboundStopSpeech, twilioStopSpeechProfileBinding } from "../../src/standalone/twilio-outbound-stop-speech.ts";
import { ClinikoTwilioOutboundStopRecovery } from "../../src/standalone/cliniko-twilio-outbound-stop-recovery.ts";
import { ClinikoOutboundLaunchOwner } from "../../src/standalone/cliniko-outbound-launch-owner.ts";
import { OwnerFileOutboundDncPolicy } from "../../src/standalone/owner-file-outbound-dnc-policy.ts";
import type { OutboundDncPolicyApproval } from "../../src/standalone/owner-file-outbound-dnc-policy.ts";
import { contactSourceBinding, contactSourceSelection } from "../../src/cliniko/internal/outbound-contact-source-context.ts";
import { decodeOutboundContactReview } from "../../src/cliniko/outbound-contact-review.ts";
import { outboundDncRecordBinding } from "../../src/cliniko/outbound-dnc-records.ts";
import { decodeTwilioOutboundReport, TwilioOutboundReportAuthentication } from "../../src/cliniko/twilio-outbound-report.ts";
import { outboundContactLifecycleFixture } from "./outbound-contact-lifecycle.ts";
import { approvedSyntheticPolicy, syntheticSpeech, withApprovedSyntheticVoice } from "./approved-voice.ts";
import { listenTwilioOutboundTest } from "./twilio-outbound-ingress.ts";
import { value } from "./outbound-records.ts";

/** A real native guarded launch, actual signed HTTP/WSS ingress, endpointing,
 * concrete speech producer and native DNC owner. Only remote transports and
 * acoustic providers are synthetic; no prepared producer report is inserted. */
type BaseOptions = NonNullable<Parameters<typeof outboundContactLifecycleFixture>[0]>;
export async function twilioOutboundStopSpeechFixture(options: Pick<BaseOptions, "apiKey" | "scope" | "patientId" | "budget" | "effectFactory" | "capacityFactory" | "capacity" | "guardRef"> & {
  text?: string; quality?: "clear" | "needsClarification"; omitProfileBinding?: boolean;
  reportResponse?: "lostStored" | "lostUnstored"; decisionResponse?: "lostStored" | "lostUnstored";
} = {}) {
  const f = await outboundContactLifecycleFixture(options);
  try {
    const key = randomBytes(32), reports = { ...f.config.requests, outboundProviderReportRecallTypeId: "64", providerReportPolicyDigest: "b".repeat(64) };
    const approval: OutboundConversationApproval = { purpose: "outboundContact", runtimeConfigurationHash: "a".repeat(64), mediaOptions: { silenceMs: 100 },
      ...(!options.omitProfileBinding ? { stopSpeechBinding: twilioStopSpeechProfileBinding(reports, key)! } : {}),
      policy: approvedSyntheticPolicy({ ...referenceDefaultPolicy(f.request.scope), automationEnabled: true, greeting: {
        scope: f.request.scope, version: "outbound-v1", ownerRef: "clinic-owner", approved: true,
        approvedText: "Hello, this is Abby calling on behalf of the clinic.", effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" } }) };
    const carrier = { ref: "synthetic-provider", profileRef: outboundConversationProfileRef(approval)!, accountSid: "AC" + "a".repeat(32),
      authToken: `synthetic-stop-speech-${randomUUID()}`, from: "+61255550100", publicAnswerUrl: "https://clinic.example.invalid/outbound/answer",
      publicStatusUrl: "https://clinic.example.invalid/outbound/status", publicStreamUrl: "wss://clinic.example.invalid/outbound/stream",
      contextKey: randomBytes(32), now: () => f.state.now };
    const callSid = "CA" + "b".repeat(32), streamSid = "MZ" + "c".repeat(32); let form!: URLSearchParams, calls = 0;
    const runtime = new TwilioAbbyOutboundRuntime(carrier, async (_input, init) => {
      calls++; form = new URLSearchParams(String(init?.body));
      return Response.json({ account_sid: carrier.accountSid, sid: callSid, to: form.get("To"), from: carrier.from,
        direction: "outbound-api", status: "queued", parent_call_sid: null, uri: `/2010-04-01/Accounts/${carrier.accountSid}/Calls/${callSid}.json` }, { status: 201 });
    });
    const launchOwner = value(ClinikoOutboundLaunchOwner.create(f.config, { ...f.ports, provider: value(bindOutboundVoiceRuntime(runtime)).launch }));
    assert.equal(value(await launchOwner.launchOnce(f.binding, new AbortController().signal)).kind, "accepted");
    const { attempt, row: attemptRow } = f.retained(), dnc = { source: f.config.contact, automationPrincipalRef: "clinic-approved-optout-automation" };
    const { source: _source, ...common } = f.approval;
    const policyApproval: OutboundDncPolicyApproval = { ...common, revision: "automatic-dnc-v1", dnc: {
      sourceBinding: contactSourceBinding(contactSourceSelection(dnc.source)), automationPrincipalRef: dnc.automationPrincipalRef,
      provider: { ref: runtime.binding().ref, bindingDigest: runtime.binding().bindingDigest }, participant: "anyAtDialledNumber",
      consent: "unknown", doNotCall: "blocked", reconsent: "clinicApprovalOnly" } };
    const policyPath = join(dirname(f.definitionConfig.path), "speech-stop-policy.json");
    await writeFile(policyPath, JSON.stringify(policyApproval), { mode: 0o600 });
    const policy = value(await OwnerFileOutboundDncPolicy.capture({ path: policyPath, scope: f.request.scope, directory: f.directory,
      clock: () => f.state.now }, new AbortController().signal));
    const state = { live: true, report: true, history: true, decision: true, producer: true, conversation: true,
      beforeReport: undefined as (() => void | Promise<void>) | undefined, beforeDecision: undefined as (() => void | Promise<void>) | undefined };
    const reportPosts: Record<string, unknown>[] = [], dncPosts: Record<string, unknown>[] = [], burned = new Set<string>();
    const native: typeof fetch = async (input, init) => {
      if (init?.method !== "POST") return f.native(input, init);
      const body = JSON.parse(String(init.body));
      if (body.recall_type_id !== "64" && body.recall_type_id !== "91") return f.native(input, init);
      assert.equal(String(input), "https://api.au5.cliniko.com/v1/recalls"); assert.equal(init.redirect, "error");
      assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from(`${reports.apiKey}:`).toString("base64")}`);
      assert.equal(body.patient_id, f.request.patientId); assert.equal(body.recalled, false);
      const report = body.recall_type_id === "64";
      (report ? reportPosts : dncPosts).push(body); await (report ? state.beforeReport?.() : state.beforeDecision?.());
      if (report) value(decodeTwilioOutboundReport(body.notes)); else value(decodeOutboundContactReview(body.notes));
      const id = report ? "250" : "300", row = { ...attemptRow, id, notes: body.notes, recall_at: body.recall_at,
        links: { self: `https://api.au5.cliniko.com/v1/recalls/${id}` },
        recall_type: { links: { self: `https://api.au5.cliniko.com/v1/recall_types/${body.recall_type_id}` } }, created_at: f.state.now, updated_at: f.state.now };
      const response = report ? options.reportResponse : options.decisionResponse;
      if (response !== "lostUnstored") f.contactControls.rows.push(row);
      if (response) throw Error("Synthetic native response lost");
      return Response.json(row, { status: 201 });
    };
    const effects = (scope: typeof f.request.scope, owner: string) => options.effectFactory?.(scope, owner) ?? ({
      matches: (s: typeof scope, b: string) => JSON.stringify(s) === JSON.stringify(scope) && b === owner,
      claimOnce: async (ref: string) => { const id = owner + ":" + ref, claimed = !burned.has(id); burned.add(id); return ok({ claimed }); }
    });
    const config = { runtime, reportKey: key, reports, stop: { requests: f.config.requests, attempts: f.config.attempts, dnc, policy,
      maximumNativeRequests: 60, deadlineMs: 15000 } };
    const ports = { attempt: f.ports.attempt, request: f.ports.request, contact: f.ports.contact, definition: f.definition,
      report: { allows: async () => state.report, current: () => state.live, producerAdmitted: async () => state.producer },
      reports: { allowsHistoryRead: async () => state.history, allowsRecordRead: async () => state.history, current: () => state.live },
      record: { allows: async () => state.decision, current: () => state.live, producerAdmitted: async () => state.producer },
      authority: { allows: async () => state.decision, current: () => state.live }, effects, native };
    const make = () => TwilioOutboundStopSpeech.create(config, ports), producer = value(make());
    const spoken: string[] = [], intents: string[] = [], acceptedTranscripts: string[] = [];
    let drained!: () => void;
    const finished = new Promise<void>(resolve => { drained = resolve; });
    let admitted: { ledger: MemoryLedger; receipt: AdmissionReceipt; sessionId: string; session: VoiceSession } | undefined;
    const conversation = twilioAbbyOutboundConversation({ runtime, stopSpeech: producer, runtimeConfigurationHash: approval.runtimeConfigurationHash,
      source: { read: async () => ok(approval), current: () => state.conversation }, readiness: async () => ok(true), now: () => f.state.now,
      mediaOptions: approval.mediaOptions,
      ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
        transcriptionFactory: sessionId => ({ accept: async () => ok([]), flush: async generation => {
          // Media timestamps end at +120ms; independently observed fixture time
          // advances past that actual frame before native records are produced.
          f.state.now = "2026-11-02T00:00:01.000Z";
          return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: "outgoing-stop", text: options.text ?? "Please stop calling me.", quality: options.quality ?? "clear" }]);
        } }) }),
      session(ledger, receipt, sessionId, playback) {
        const reception = new TextReception(ledger, withApprovedSyntheticVoice(new MemoryPolicyStore()), new ReferenceClinicHost([], []));
        const session = new VoiceSession(receipt.callId, sessionId, receipt.scope, ledger, reception, playback,
          async turn => { intents.push(turn.text); return ok({ kind: "clarify" }); });
        const accept = session.acceptTranscript.bind(session);
        session.acceptTranscript = event => { acceptedTranscripts.push(event.text); return accept(event); };
        admitted = { ledger, receipt, sessionId, session }; return session;
      } });
    const ingress = new TwilioOutboundIngress({ runtime, authority: { allows: async () => state.live, current: () => state.live },
      sessionEffects: effects, createCall: async (...args) => {
        const call = await conversation(...args);
        return { receive: call.receive, disconnect: async () => { try { await call.disconnect(); } finally { drained(); } } };
      } });
    const original = () => {
      const url = new URL(form.get("Url")!), fields = { AccountSid: carrier.accountSid, CallSid: callSid, From: carrier.from,
        To: f.request.recipient.number, Direction: "outbound-api", CallStatus: "in-progress" };
      // Independent signed reconstruction uses the exact encrypted context sent
      // on the original native carrier launch, not a fabricated recovery map.
      return value(runtime.authenticateAnswer({ method: "POST", requestTarget: url.pathname + url.search,
        contentType: "application/x-www-form-urlencoded", signature: getExpectedTwilioSignature(carrier.authToken, url.href, fields),
        body: new URLSearchParams(fields).toString() })).call.context;
    };
    const recover = () => {
      const auth = new TwilioOutboundReportAuthentication(key, attempt.provider), dncBinding = outboundDncRecordBinding(dnc)!;
      const { report: _report, effects: _effects, ...reads } = ports;
      return value(ClinikoTwilioOutboundStopRecovery.create(config, { ...reads, runtime, authentication: auth,
        effects: effects(f.request.scope, dncBinding) })).recoverRetainedReport(original(), carrier.accountSid, callSid, new AbortController().signal);
    };
    async function listen() {
      const inbound = new TwilioSignedIngress({ accountSid: carrier.accountSid, authToken: carrier.authToken,
        publicWebhookUrl: "https://clinic.example.invalid/inbound", publicStreamUrl: "wss://clinic.example.invalid/inbound/stream",
        fallbackNumbers: { [carrier.from]: "+61255550199" }, bindingKey: randomBytes(32), now: () => new Date(f.state.now) });
      const server = createTwilioIngressServer({ ingress: inbound, outbound: ingress, createCall: async () => { throw Error("Must stay outbound"); } });
      return listenTwilioOutboundTest(server, { config: carrier, form, number: f.request.recipient.number, callSid, streamSid });
    }
    async function start(server: Awaited<ReturnType<typeof listen>>) {
      const response = await server.post(); assert.equal(response.status, 200);
      const wire = await server.open(await response.text()), messages: Record<string, unknown>[] = [];
      wire.socket.on("message", raw => { messages.push(JSON.parse(raw.toString())); });
      assert.equal(await wire.outcome, "ready");
      for (let i = 0; !messages.some(m => m.event === "mark") && i < 20; i++) await once(wire.socket, "message");
      const marker = messages.find(m => m.event === "mark")!.mark;
      wire.socket.send(JSON.stringify({ event: "mark", sequenceNumber: "2", streamSid, mark: marker }));
      const pong = once(wire.socket, "pong"); wire.socket.ping(); await pong;
      return { ...wire, messages, sendTurn() {
        for (let index = 0; index < 7; index++) wire.socket.send(JSON.stringify({ event: "media", sequenceNumber: String(index + 3), streamSid,
          media: { track: "inbound", chunk: String(index + 1), timestamp: String(index * 20), payload: Buffer.alloc(160, index < 2 ? 0x9f : 0xff).toString("base64") } }));
      } };
    }
    return { ...f, key, config, ports, producer, makeSpeech: make, stateSpeech: state, policyPath, policyApproval, reports, reportPosts, dncPosts, nativeSpeech: native,
      runtime, carrier, callSid, streamSid, form, attempt, effects, speechBurned: burned, approval, spoken, intents, acceptedTranscripts, listen, start, finished, recover, original,
      get carrierCalls() { return calls; }, get admitted() { return admitted; } };
  } catch (error) { await f.close(); throw error; }
}
