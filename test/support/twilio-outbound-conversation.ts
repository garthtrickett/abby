import assert from "node:assert/strict";
import { ok } from "../../src/core/model.ts";
import type { MemoryLedger } from "../../src/core/ledger.ts";
import type { AdmissionReceipt } from "../../src/core/model.ts";
import { CallRuntime } from "../../src/core/runtime.ts";
import { TextReception } from "../../src/reference/text-reception.ts";
import { ReferenceClinicHost } from "../../src/reference/clinic-host.ts";
import { MemoryPolicyStore, referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { VoiceSession } from "../../src/voice/voice-session.ts";
import { outboundConversationProfileRef } from "../../src/voice/outbound-voice-entry.ts";
import type { OutboundConversationApproval } from "../../src/voice/outbound-voice-entry.ts";
import { twilioAbbyOutboundConversation } from "../../src/standalone/twilio-outbound-conversation.ts";
import type { TwilioAbbyOutboundConversationConfig, OutboundVoicePreparation } from "../../src/standalone/twilio-outbound-conversation.ts";
import type { PreparedVoiceSession, FullVoiceSessionFactory } from "../../src/voice/reception-voice-call.ts";
import type { TwilioOutboundIngressConfig } from "../../src/voice/twilio-outbound-ingress.ts";
import { approvedSyntheticPolicy, syntheticSpeech, withApprovedSyntheticVoice } from "./approved-voice.ts";
import { outboundLaunchValue } from "./outbound-launch.ts";
import { twilioOutboundIngressFixture } from "./twilio-outbound-ingress.ts";
const now = "2026-11-01T10:00:00.000Z";
export async function outboundConversationFixture(options: { changedRuntime?: boolean; revoked?: boolean; changedMedia?: boolean; withdrawDuringTranscription?: "accept" | "flush";
  sessionEffects?: TwilioOutboundIngressConfig["sessionEffects"];
  identities?: NonNullable<Parameters<typeof twilioOutboundIngressFixture>[0]>["identities"];
  prepare?: (context: OutboundVoicePreparation, create: FullVoiceSessionFactory) => Promise<PreparedVoiceSession> } = {}) {
  const scope = outboundLaunchValue().attempt.scope;
  const approval: OutboundConversationApproval = { purpose: "outboundContact", runtimeConfigurationHash: "a".repeat(64), mediaOptions: { silenceMs: 100 },
    policy: approvedSyntheticPolicy({ ...referenceDefaultPolicy(scope), automationEnabled: true,
      greeting: { scope, version: "outbound-v1", ownerRef: "clinic-owner", approved: true,
        approvedText: "Hello, this is Abby calling on behalf of the clinic.",
        effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: "2026-12-01T00:00:00.000Z" } }) };
  let current = !options.revoked, opened = 0;
  let selected: ReturnType<typeof twilioAbbyOutboundConversation> | undefined;
  let admitted: { ledger: MemoryLedger; receipt: AdmissionReceipt; sessionId: string } | undefined;
  const spoken: string[] = [], policies: unknown[] = [], turns: string[] = [], acceptedTranscripts: string[] = [];
  const f = await twilioOutboundIngressFixture({ profileRef: outboundConversationProfileRef(approval)!,
    ...(options.sessionEffects ? { sessionEffects: options.sessionEffects } : {}),
    ...(options.identities ? { identities: options.identities } : {}),
    conversation: runtime => {
      const common: Omit<TwilioAbbyOutboundConversationConfig, "session" | "prepareSession"> = { runtime, runtimeConfigurationHash: (options.changedRuntime ? "b" : "a").repeat(64),
      source: { read: async call => { policies.push(call); return ok(approval); }, current: () => current }, readiness: async () => ok(true), now: () => now,
      mediaOptions: { silenceMs: options.changedMedia ? 200 : 100 },
      ...syntheticSpeech({ synthesis: { async *stream(text) { spoken.push(text); yield new Uint8Array(640); } },
        transcriptionFactory: sessionId => ({ accept: async (_frame, generation) => {
          if (options.withdrawDuringTranscription !== "accept") return ok([]);
          await Promise.resolve(); current = false;
          return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: "outgoing-one", text: "Hello, can you help?", quality: "clear" }]);
        }, flush: async generation => {
          await Promise.resolve(); if (options.withdrawDuringTranscription === "flush") current = false;
          return ok([{ kind: "segmentFinal", sessionId, generation, utteranceId: "outgoing-one", text: "Hello, can you help?", quality: "clear" }]);
        } }) }) };
      const session: NonNullable<TwilioAbbyOutboundConversationConfig["session"]> = (ledger, receipt, sessionId, playback, _signal, original) => {
        assert.deepEqual(original, f.original);
        opened++; admitted = { ledger, receipt, sessionId };
        const reception = new TextReception(ledger, withApprovedSyntheticVoice(new MemoryPolicyStore()), new ReferenceClinicHost([], []));
        const session = new VoiceSession(receipt.callId, sessionId, receipt.scope, ledger, reception, playback,
          async turn => { turns.push(turn.text); return ok({ kind: "clarify" }); });
        const acceptTranscript = session.acceptTranscript.bind(session);
        session.acceptTranscript = event => { acceptedTranscripts.push(event.text); return acceptTranscript(event); };
        return session;
      };
      selected = twilioAbbyOutboundConversation(options.prepare ? { ...common, prepareSession: context => options.prepare!(context,
        (receipt, id, playback) => session(context.ledger, receipt, id, playback, context.signal, context.original)) } : { ...common, session });
      return selected;
    } });
  return { ...f, scope, approval, spoken, policies, turns, acceptedTranscripts, get opened() { return opened; }, get admitted() { return admitted; },
    get conversation() { assert.ok(selected); return selected; }, revoke() { current = false; } };
}
