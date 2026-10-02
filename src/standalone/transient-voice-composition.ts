import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { ClinikoApprovedAvailabilitySearch } from "../cliniko/approved-availability-search.ts";
import { MemoryLedger } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { AdmissionReceipt, ApprovedGreeting, LocationScope, Result } from "../core/model.ts";
import { unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import { standaloneDefaultPolicy } from "./default-policy.ts";
import { TextReception } from "../reference/text-reception.ts";
import { PostgresPolicyStore } from "../storage/postgres-policy-store.ts";
import { checkStandaloneTextDatabase } from "../storage/standalone-privacy-preflight.ts";
import type { StandalonePrivacyPreflightFailure } from "../storage/standalone-privacy-preflight.ts";
import type Database from "../storage/generated/Database.ts";
import { CallAdmissionService } from "../voice/admission.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import type { MediaTurnOptions, TranscriptionPort } from "../voice/media-turn-controller.ts";
import { SharedNumberIntakeService } from "../voice/shared-number-intake.ts";
import type { SpeechSynthesisPort, StreamedPlaybackOptions } from "../voice/streamed-playback-port.ts";
import { TwilioConnectedCall } from "../voice/twilio-connected-call.ts";
import type { TwilioWireCall } from "../voice/twilio-ingress-server.ts";
import type { AuthenticatedTwilioStream } from "../voice/twilio-signed-ingress.ts";
import { VoiceSession } from "../voice/voice-session.ts";
import type { IntentResolver } from "../voice/voice-session.ts";
import type { ClinicNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import { ClinicPolicyRouter } from "../reference/clinic-number-routing.ts";
import { DisabledStandaloneHost } from "./disabled-host.ts";
import { VerifiedAppointmentReadSession } from "./verified-appointment-read-session.ts";

type TranscriptionSource =
  | Readonly<{ transcription: TranscriptionPort; transcriptionFactory?: never }>
  | Readonly<{ transcription?: never; transcriptionFactory: (sessionId: string) => TranscriptionPort }>;

export type TransientVoiceConfig = Readonly<{
  db: Kysely<Database>;
  routingHost: ClinicNumberRoutingHost;
  expectedPolicyVersion?: string;
  stream: AuthenticatedTwilioStream;
  send: (json: string) => "queued" | "notSent" | "uncertain";
  synthesis: SpeechSynthesisPort;
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
  mediaOptions?: MediaTurnOptions;
  playbackOptions?: StreamedPlaybackOptions;
  now?: () => string;
  monotonicNow?: () => number;
}> & TranscriptionSource;

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
  const sessionId = randomUUID();
  const transcription = config.transcriptionFactory
    ? config.transcriptionFactory(sessionId) : config.transcription;
  if (!transcription) throw new TypeError("standalone transcription unavailable");
  const readiness = config.readiness ?? unprovenReadiness;
  const now = config.now ?? (() => new Date().toISOString());
  const ledger = new MemoryLedger(readiness);
  const defaultPolicy = (scope: LocationScope) => ({ ...standaloneDefaultPolicy(scope),
    ...(config.approvedGreeting ? { greeting: structuredClone(config.approvedGreeting) } : {}) });
  const policy = new PostgresPolicyStore(config.db, defaultPolicy, "unavailable", readiness, false, "standaloneMinimal", true);
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
  const admission = new CallAdmissionService(ledger, router.resolve, now, readiness);
  const intake = new SharedNumberIntakeService(ledger, router, admission, now);
  const host = new DisabledStandaloneHost();
  const lifetime = new AbortController();
  const providerAvailability = config.availability;
  const availability = providerAvailability ? {
    list: (scope: LocationScope, from: string, to: string) =>
      providerAvailability.list(scope, from, to, lifetime.signal),
  } : undefined;
  let verifiedRead: VerifiedAppointmentReadSession | undefined;
  let call: TwilioConnectedCall | undefined = new TwilioConnectedCall({
    event: config.stream.event, streamStartedAt: config.stream.streamStartedAt,
    sessionId, ledger, intake, transcription,
    synthesis: config.synthesis, send: config.send, now,
    ...(config.closeTransport ? { closeTransport: config.closeTransport } : {}),
    ...(config.keypadAvailabilityRange ? { keypadAvailabilityRange: config.keypadAvailabilityRange } : {}),
    ...(config.callerCandidateLookup ? { callerCandidateLookup: config.callerCandidateLookup } : {}),
    ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
    ...(config.playbackOptions ? { playbackOptions: config.playbackOptions } : {}),
    ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
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
      const reception = new TextReception(ledger, policy, host, availability,
        verifiedRead?.appointments, undefined, host);
      return new VoiceSession(receipt.callId, sessionId, receipt.scope, ledger, reception, playback,
        config.resolveIntent, undefined, config.monotonicNow, { greeting });
    },
  });
  let release: Promise<void> | undefined;
  const dispose = (): Promise<void> => release ??= (async () => {
    const active = call;
    call = undefined;
    try { await active?.disconnect(); }
    finally { lifetime.abort(); verifiedRead?.dispose(); verifiedRead = undefined; ledger.dispose(); greeting = undefined; }
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
