import type { VoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import type { SpeechAdapterFactory } from "../voice/call-speech-binding.ts";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { ClinikoApprovedAvailabilitySearch } from "../cliniko/approved-availability-search.ts";
import { MemoryLedger } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, ApprovedGreeting, LocationScope, Result } from "../core/model.ts";
import type { PolicyStore } from "../core/host.ts";
import { unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import { standaloneDefaultPolicy } from "./default-policy.ts";
import { TextReception } from "../reference/text-reception.ts";
import { PostgresPolicyStore } from "../storage/postgres-policy-store.ts";
import { checkStandaloneTextDatabase } from "../storage/standalone-privacy-preflight.ts";
import type { StandalonePrivacyPreflightFailure } from "../storage/standalone-privacy-preflight.ts";
import type Database from "../storage/generated/Database.ts";
import { CallAdmissionService, callIdFor } from "../voice/admission.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import type { MediaTurnOptions, TranscriptionPort } from "../voice/media-turn-controller.ts";
import { SharedNumberIntakeService } from "../voice/shared-number-intake.ts";
import type { StreamedPlaybackOptions } from "../voice/streamed-playback-port.ts";
import { TwilioConnectedCall } from "../voice/twilio-connected-call.ts";
import type { TwilioWireCall } from "../voice/twilio-ingress-server.ts";
import type { AuthenticatedTwilioStream } from "../voice/twilio-signed-ingress.ts";
import { VoiceSession } from "../voice/voice-session.ts";
import type { IntentResolver } from "../voice/voice-session.ts";
import type { ClinicNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import { ClinicPolicyRouter } from "../reference/clinic-number-routing.ts";
import { DisabledStandaloneHost } from "./disabled-host.ts";
import { VerifiedAppointmentReadSession } from "./verified-appointment-read-session.ts";
import { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import { PrivateWorkflowKeypad } from "./private-workflow-keypad.ts";
import { OwnerFileClinicFAQs } from "./owner-file-clinic-faqs.ts";
import { PrivateIntakeVoiceInput } from "./private-intake-voice-input.ts";

export type ClinikoVoiceWorkflow = Readonly<{
  /** A trusted host supplies current scoped activation evidence and settings. The runnable CLI
   * leaves this entire seam unset while clinic, mail and speech activation remain unproven. */
  policies: PolicyStore;
  publicKnowledge?: OwnerFileClinicFAQs;
  create(context: Readonly<{ receipt: AdmissionReceipt; inbound: AuthenticatedInboundCall; sessionId: string;
    ledger: MemoryLedger; policies: PolicyStore; signal: AbortSignal; clock: () => string;
    privatePresentation: Readonly<{ play(text: string, signal: AbortSignal): Promise<boolean> }> }>): ClinikoCallFlow;
  intent(owner: ClinikoCallFlow): IntentResolver;
  /** A separate approved adapter for registration fields; it is never used during code entry. */
  privateIntakeTranscription?: (sessionId: string) => TranscriptionPort;
}>;

export type TransientVoiceConfig = Readonly<{
  db: Kysely<Database>;
  routingHost: ClinicNumberRoutingHost;
  expectedPolicyVersion?: string;
  stream: AuthenticatedTwilioStream;
  send: (json: string) => "queued" | "notSent" | "uncertain";
  voiceProfiles: VoiceProfileRegistry & SpeechAdapterFactory;
  resolveIntent: IntentResolver;
  readiness?: AutomationReadiness;
  availability?: ClinikoAvailabilityReader | ClinikoApprovedAvailabilitySearch;
  approvedGreeting?: ApprovedGreeting;
  /** The serving route checks the stored opening words against its offered keypad choices. */
  greetingValidator?: (greeting: ApprovedGreeting | undefined) => boolean;
  keypadAvailabilityRange?: (digit: string) => Readonly<{ from: string; to: string }> | null | undefined;
  closeTransport?: () => void;
  callerCandidateLookup?: CallerCandidateLookup;
  /** Trusted host seam for a clinic-approved verifier. The live runner leaves it unset. */
  verifiedAppointmentRead?: (receipt: AdmissionReceipt, inbound: AuthenticatedInboundCall,
    sessionId: string) => VerifiedAppointmentReadSession;
  clinicalWorkflow?: ClinikoVoiceWorkflow;
  mediaOptions?: MediaTurnOptions;
  playbackOptions?: StreamedPlaybackOptions;
  now?: () => string;
  monotonicNow?: () => number;
}>;

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

/** One socket owns one volatile SAM ledger. PostgreSQL supplies settings only. */
export async function createStandaloneTransientVoiceCall(config: TransientVoiceConfig):
  Promise<Result<TwilioWireCall, StandalonePrivacyPreflightFailure>> {
  const safe = await checkStandaloneTextDatabase(config.db);
  if (!safe.ok) return safe;
  if (config.availability && !(config.availability instanceof ClinikoAvailabilityReader) &&
      !(config.availability instanceof ClinikoApprovedAvailabilitySearch)) {
    throw new TypeError("standalone availability requires a Cliniko reader");
  }
  if (config.keypadAvailabilityRange && (!config.availability || !config.approvedGreeting)) {
    throw new TypeError("keypad availability requires a Cliniko reader and approved greeting");
  }
  if (config.clinicalWorkflow && (config.verifiedAppointmentRead || config.keypadAvailabilityRange)) {
    throw new TypeError("clinical workflow requires its own private input and appointment owner");
  }
  const sessionId = randomUUID();
  const readiness = config.readiness ?? unprovenReadiness;
  const now = config.now ?? (() => new Date().toISOString());
  const ledger = new MemoryLedger(readiness);
  const defaultPolicy = (scope: LocationScope) => ({ ...standaloneDefaultPolicy(scope),
    ...(config.approvedGreeting ? { greeting: structuredClone(config.approvedGreeting) } : {}) });
  const policy = config.clinicalWorkflow?.policies ?? new PostgresPolicyStore(config.db, defaultPolicy, "unavailable", readiness, false, "standaloneMinimal", true, undefined, undefined, undefined, config.voiceProfiles);
  let greeting: ApprovedGreeting | undefined;
  const router = new ClinicPolicyRouter(config.routingHost, { read: async scope => {
    const loaded = await policy.read(scope);
    if (loaded.ok && config.expectedPolicyVersion !== undefined &&
        loaded.value.policyVersion !== config.expectedPolicyVersion) return err({ kind: "versionConflict" });
    if (loaded.ok && config.greetingValidator && !config.greetingValidator(loaded.value.greeting)) {
      return err({ kind: "invalidValue" });
    }
    if (loaded.ok) greeting = loaded.value.greeting;
    return loaded;
  } });
  const publicKnowledge = config.clinicalWorkflow?.publicKnowledge;
  if (publicKnowledge !== undefined && !(publicKnowledge instanceof OwnerFileClinicFAQs)) throw new TypeError("invalid public clinic facts");
  const admission = new CallAdmissionService(ledger, router.resolve, now, readiness, publicKnowledge);
  const intake = new SharedNumberIntakeService(ledger, router, admission, now);
  const host = new DisabledStandaloneHost();
  const lifetime = new AbortController();
  const providerAvailability = config.availability;
  const availability = providerAvailability ? {
    list: (scope: LocationScope, from: string, to: string) =>
      providerAvailability.list(scope, from, to, lifetime.signal),
  } : undefined;
  let verifiedRead: VerifiedAppointmentReadSession | undefined;
  let workflow: ClinikoCallFlow | undefined;
  let voice: VoiceSession | undefined;
  const privatePresentation = { play: (text: string, signal: AbortSignal) => voice?.presentPrivateIntake(text, signal, now()) ?? Promise.resolve(false) };
  const privateBinding = { callId: callIdFor(config.stream.event.key), sessionId, owner: () => workflow };
  const privateInput = config.clinicalWorkflow?.privateIntakeTranscription ? new PrivateIntakeVoiceInput({ ...privateBinding,
    phone: config.stream.event.presentedCallerNumber ?? "", present: privatePresentation.play, signal: lifetime.signal,
    transcriptionFactory: config.clinicalWorkflow.privateIntakeTranscription, ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}) }) :
    config.clinicalWorkflow ? new PrivateWorkflowKeypad(privateBinding) : undefined;
  let call: TwilioConnectedCall | undefined = new TwilioConnectedCall({
    event: config.stream.event, streamStartedAt: config.stream.streamStartedAt,
    sessionId, ledger, intake, speech: config.voiceProfiles, send: config.send, now,
    ...(config.closeTransport ? { closeTransport: config.closeTransport } : {}),
    ...(config.keypadAvailabilityRange ? { keypadAvailabilityRange: config.keypadAvailabilityRange } : {}),
    ...(config.callerCandidateLookup ? { callerCandidateLookup: config.callerCandidateLookup } : {}),
    ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
    ...(config.playbackOptions ? { playbackOptions: config.playbackOptions } : {}),
    ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
    ...(privateInput ? { privateKeypadInput: privateInput } : {}),
    onCallStop: () => lifetime.abort(),
    fullFactory: (receipt, sessionId, playback) => {
      if (!greeting || !sameScope(greeting.scope, receipt.scope)) throw new Error("approved greeting unavailable");
      verifiedRead?.dispose();
      verifiedRead = undefined;
      const candidate = config.verifiedAppointmentRead?.(receipt, config.stream.event, sessionId);
      if (candidate !== undefined && !(candidate instanceof VerifiedAppointmentReadSession)) {
        throw new TypeError("invalid verified appointment reader");
      }
      verifiedRead = candidate;
      workflow?.dispose(); workflow = undefined;
      if (config.clinicalWorkflow) {
        const owner = config.clinicalWorkflow.create({ receipt, inbound: config.stream.event, sessionId, ledger, policies: policy, signal: lifetime.signal, clock: now, privatePresentation });
        const binding = owner instanceof ClinikoCallFlow ? owner.binding() : undefined;
        if (!binding || binding.callId !== receipt.callId || binding.sessionId !== sessionId) { owner?.dispose(); throw new TypeError("invalid clinical workflow ownership"); }
        workflow = owner;
      }
      const appointments = workflow ? {
        list: (...args: Parameters<NonNullable<ClinikoCallFlow["appointments"]>["list"]>) => workflow?.appointments?.list(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
        select: (...args: Parameters<NonNullable<ClinikoCallFlow["appointments"]>["select"]>) => workflow?.appointments?.select(...args) ?? Promise.resolve(err({ kind: "unavailable" as const })),
      } : verifiedRead?.appointments;
      const reception = new TextReception(ledger, policy, workflow ?? host, availability, appointments, undefined, publicKnowledge ?? host);
      voice = new VoiceSession(receipt.callId, sessionId, receipt.scope, ledger, reception, playback,
        workflow ? config.clinicalWorkflow!.intent(workflow) : config.resolveIntent, undefined, config.monotonicNow, { greeting });
      return voice;
    },
  });
  let release: Promise<void> | undefined;
  const dispose = (): Promise<void> => release ??= (async () => {
    const active = call;
    call = undefined;
    try { await active?.disconnect(); }
    finally { lifetime.abort(); workflow?.dispose(); workflow = undefined; voice = undefined; verifiedRead?.dispose(); verifiedRead = undefined; ledger.dispose(); greeting = undefined; }
  })();
  return ok({
    async receive(raw) {
      const active = call;
      if (!active) return err({ kind: "streamClosed" });
      try {
        const result = await active.receive(raw);
        if (!result.ok || result.value.kind === "stopped") await dispose();
        return result;
      } catch {
        await dispose().catch(() => undefined);
        return err({ kind: "streamUnavailable" });
      }
    },
    disconnect: dispose,
  });
}
