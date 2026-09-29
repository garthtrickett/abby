import type { LedgerStore } from "../core/ledger.ts";
import type { EffectCallLeaseStore } from "../core/effect-call-lease.ts";
import type { AppointmentHost, AvailabilityHost, KnowledgeHost, ModelKnowledgeContextHost,
  PolicyStore } from "../core/host.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import type { ModelWork } from "../model/work.ts";
import { CallAdmissionService } from "../voice/admission.ts";
import { ConnectedVoiceCall } from "../voice/connected-voice-call.ts";
import type { ConnectedVoiceCallConfig } from "../voice/connected-voice-call.ts";
import { SharedNumberIntakeService } from "../voice/shared-number-intake.ts";
import { VoiceSession } from "../voice/voice-session.ts";
import type { IntentResolver, TransferPort } from "../voice/voice-session.ts";
import { ClinicPolicyRouter } from "./clinic-number-routing.ts";
import type { ClinicNumberRoutingHost } from "./clinic-number-routing.ts";
import { createEmbeddedTextComposition } from "./embedded-composition.ts";
import type { TextHost } from "./text-reception.ts";

export type EmbeddedVoiceCompositionConfig = Omit<ConnectedVoiceCallConfig,
  "ledger" | "intake" | "fullFactory"> & Readonly<{
  ledger: LedgerStore & EffectCallLeaseStore;
  policy: PolicyStore;
  routing: ClinicNumberRoutingHost;
  host: TextHost;
  readiness: AutomationReadiness;
  resolveIntent: IntentResolver;
  transfer?: TransferPort;
  availability?: AvailabilityHost;
  appointments?: AppointmentHost;
  model?: ModelWork;
  knowledge?: KnowledgeHost & Partial<ModelKnowledgeContextHost>;
  now?: () => string;
}>;

/** Host-owned storage, settings, clinical actions, and transport around Abby's shared voice call. */
export function createEmbeddedVoiceComposition(config: EmbeddedVoiceCompositionConfig): ConnectedVoiceCall {
  const now = config.now ?? (() => new Date().toISOString());
  const router = new ClinicPolicyRouter(config.routing, config.policy);
  const admission = new CallAdmissionService(config.ledger, router.resolve, now, config.readiness);
  const intake = new SharedNumberIntakeService(config.ledger, router, admission, now);
  const reception = createEmbeddedTextComposition(config.ledger, config.policy, config.host,
    config.availability, config.appointments, config.model, config.knowledge);
  return new ConnectedVoiceCall({ event: config.event, sessionId: config.sessionId,
    ledger: config.ledger, intake, transcription: config.transcription, synthesis: config.synthesis,
    output: config.output,
    ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
    ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
    ...(config.playbackOptions ? { playbackOptions: config.playbackOptions } : {}),
    ...(config.callerCandidateLookup ? { callerCandidateLookup: config.callerCandidateLookup } : {}),
    fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId,
      receipt.scope, config.ledger, reception, playback, config.resolveIntent,
      config.transfer, config.monotonicNow),
  });
}
