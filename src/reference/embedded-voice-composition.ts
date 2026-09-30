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
import type { FullVoiceSessionFactory } from "../voice/shared-number-voice-call.ts";
import { TwilioConnectedCall } from "../voice/twilio-connected-call.ts";
import type { TwilioConnectedCallConfig } from "../voice/twilio-connected-call.ts";
import { VoiceSession } from "../voice/voice-session.ts";
import type { IntentResolver, TransferPort } from "../voice/voice-session.ts";
import { ClinicPolicyRouter } from "./clinic-number-routing.ts";
import type { ClinicNumberRoutingHost } from "./clinic-number-routing.ts";
import { createEmbeddedTextComposition } from "./embedded-composition.ts";
import type { TextHost } from "./text-reception.ts";

export type EmbeddedVoiceHostConfig = Readonly<{
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
  knowledge?: KnowledgeHost & ModelKnowledgeContextHost;
  now?: () => string;
}>;
export type EmbeddedVoiceCompositionConfig = Omit<ConnectedVoiceCallConfig,
  "ledger" | "intake" | "fullFactory"> & EmbeddedVoiceHostConfig;
export type EmbeddedTwilioVoiceCompositionConfig = Omit<TwilioConnectedCallConfig,
  "ledger" | "intake" | "fullFactory"> & EmbeddedVoiceHostConfig;

function hostVoiceServices(config: EmbeddedVoiceHostConfig &
  Pick<ConnectedVoiceCallConfig, "monotonicNow">): Readonly<{
  intake: SharedNumberIntakeService;
  fullFactory: FullVoiceSessionFactory;
}> {
  if (config.knowledge && typeof config.knowledge.listModelKnowledge !== "function") {
    throw new TypeError("embedded voice knowledge requires a snapshot host");
  }
  const now = config.now ?? (() => new Date().toISOString());
  const router = new ClinicPolicyRouter(config.routing, config.policy);
  const admission = new CallAdmissionService(config.ledger, router.resolve, now, config.readiness, config.knowledge);
  const intake = new SharedNumberIntakeService(config.ledger, router, admission, now);
  const reception = createEmbeddedTextComposition(config.ledger, config.policy, config.host,
    config.availability, config.appointments, config.model, config.knowledge);
  return { intake,
    fullFactory: (receipt, sessionId, playback) => new VoiceSession(receipt.callId, sessionId,
      receipt.scope, config.ledger, reception, playback, config.resolveIntent,
      config.transfer, config.monotonicNow),
  };
}

/** Host-owned storage, settings, and clinical actions around a transport-neutral voice call. */
export function createEmbeddedVoiceComposition(config: EmbeddedVoiceCompositionConfig): ConnectedVoiceCall {
  return new ConnectedVoiceCall({ ...config, ...hostVoiceServices(config) });
}

/** Mounts the same host-owned call services on a signed Twilio stream inside the buyer's process. */
export function createEmbeddedTwilioVoiceComposition(config: EmbeddedTwilioVoiceCompositionConfig): TwilioConnectedCall {
  return new TwilioConnectedCall({ ...config, ...hostVoiceServices(config) });
}
