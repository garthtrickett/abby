import type { Server } from "node:http";
import type { Kysely } from "kysely";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { err, ok } from "../core/model.ts";
import type { ApprovedGreeting, LocationScope, Result } from "../core/model.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import { ReferenceNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import type Database from "../storage/generated/Database.ts";
import { PostgresActiveCallClaims } from "../storage/postgres-active-call-claims.ts";
import { PostgresClinikoRequestBudget } from "../storage/postgres-cliniko-request-budget.ts";
import { checkStandaloneTextDatabase } from "../storage/standalone-privacy-preflight.ts";
import type { StandalonePrivacyPreflightFailure } from "../storage/standalone-privacy-preflight.ts";
import type { MediaTurnOptions } from "../voice/media-turn-controller.ts";
import { FirstChunkFallbackSpeech } from "../voice/first-chunk-fallback-speech.ts";
import { OpenAIRealtimeTranscription } from "../voice/openai-realtime-transcription.ts";
import type { OpenAIRealtimeTranscriptionConfig } from "../voice/openai-realtime-transcription.ts";
import { OpenAISpeechSynthesis } from "../voice/openai-speech-synthesis.ts";
import type { StreamedPlaybackOptions } from "../voice/streamed-playback-port.ts";
import { createTwilioIngressServer } from "../voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../voice/twilio-signed-ingress.ts";
import type { TwilioSignedIngressConfig } from "../voice/twilio-signed-ingress.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import { createOpenAIAvailabilityIntentResolver } from "./openai-availability-intent.ts";
import { keypadAvailabilityDate } from "./keypad-availability.ts";
import { createStandaloneTransientVoiceCall } from "./transient-voice-composition.ts";

export type ClinikoVoiceRoute = Readonly<{
  dialedNumber: string;
  scope: LocationScope;
  routeVersion: string;
  availability: ClinikoAvailabilityReader;
  rateBudget: PostgresClinikoRequestBudget;
  /** Today's YYYY-MM-DD date in this clinic's local time zone. */
  clinicDate: () => string;
  /** Required clinic approval: Realtime finals cannot yet authorize speech-led availability. */
  keypadAvailabilityGreeting: ApprovedGreeting;
}>;

const keypadInstructions = "Press 1 for possible times today. Press 2 for possible times tomorrow.";

export type ClinikoVoiceServerConfig = Readonly<{
  db: Kysely<Database>;
  /** Must use the same PostgreSQL database and key on every serving instance. */
  activeCallClaims: PostgresActiveCallClaims;
  twilio: TwilioSignedIngressConfig;
  routes: readonly ClinikoVoiceRoute[];
  openai: Readonly<{
    apiKey: string;
    intentModel: string;
    speechModel?: string;
    /** Opt-in alternate model; it may speak only if the primary yielded no audio. */
    speechFallbackModel?: string;
    speechPrimaryFirstChunkMs?: number;
    voice?: string;
    fetch?: typeof fetch;
    transcriptionSocketFactory?: OpenAIRealtimeTranscriptionConfig["socketFactory"];
  }>;
  readiness: AutomationReadiness;
  health?: () => Promise<boolean>;
  admitWebhook?: (event?: AuthenticatedInboundCall) => Promise<boolean>;
  mediaOptions?: MediaTurnOptions;
  playbackOptions?: StreamedPlaybackOptions;
  now?: () => string;
  monotonicNow?: () => number;
}>;

/** Refuses unsafe standalone storage before a listener can accept calls. */
export async function createStandaloneClinikoVoiceServer(config: ClinikoVoiceServerConfig):
  Promise<Result<Server, StandalonePrivacyPreflightFailure>> {
  if (!config.routes.length || config.routes.length > 1_000) throw new RangeError("invalid clinic voice routes");
  if (!(config.activeCallClaims instanceof PostgresActiveCallClaims)) {
    throw new RangeError("cross-process active call ownership required");
  }
  const twilio = { ...config.twilio, bindingKey: new Uint8Array(config.twilio.bindingKey),
    fallbackNumbers: { ...config.twilio.fallbackNumbers } };
  const fallbackNumbers = Object.keys(twilio.fallbackNumbers);
  const routes = new Map<string, ClinikoVoiceRoute>();
  for (const route of config.routes) {
    if (!route.scope.tenantId || !route.scope.clinicId || !route.scope.locationId ||
        !route.routeVersion?.trim() || !(route.availability instanceof ClinikoAvailabilityReader) ||
        !route.availability.matchesScope(route.scope) ||
        !(route.rateBudget instanceof PostgresClinikoRequestBudget) ||
        !route.rateBudget.matchesDatabase(config.db) || !route.availability.usesBudget(route.rateBudget) ||
        !route.rateBudget.matchesCredentialFingerprint(route.availability.credentialFingerprint()) ||
        typeof route.clinicDate !== "function" || routes.has(route.dialedNumber) ||
        !Object.hasOwn(twilio.fallbackNumbers, route.dialedNumber)) {
      throw new RangeError("invalid clinic voice route");
    }
    const greeting = route.keypadAvailabilityGreeting;
    if (!greeting || greeting.approved !== true || !greeting.scope ||
        greeting.scope.tenantId !== route.scope.tenantId ||
        greeting.scope.clinicId !== route.scope.clinicId ||
        greeting.scope.locationId !== route.scope.locationId ||
        !greeting.version?.trim() || greeting.version.length > 256 ||
        !greeting.ownerRef?.trim() || greeting.ownerRef.length > 256 ||
        typeof greeting.approvedText !== "string" || greeting.approvedText.length > 2_000 ||
        !greeting.approvedText.includes(keypadInstructions)) {
      throw new RangeError("invalid keypad availability greeting");
    }
    routes.set(route.dialedNumber, { ...route, scope: structuredClone(route.scope),
      keypadAvailabilityGreeting: structuredClone(greeting) });
  }
  if (routes.size !== fallbackNumbers.length) throw new RangeError("incomplete clinic voice routes");
  const ingress = new TwilioSignedIngress(twilio);
  const routingHost = new ReferenceNumberRoutingHost([...routes.values()].map(route => ({
    accountRef: twilio.accountSid, dialedNumber: route.dialedNumber,
    ...route.scope, routeVersion: route.routeVersion,
  })));
  const openaiApiKey = config.openai.apiKey;
  const transcriptionSocketFactory = config.openai.transcriptionSocketFactory;
  const readiness = config.readiness;
  // Validate provider configuration before exposing an HTTP listener.
  const primarySynthesis = new OpenAISpeechSynthesis({ apiKey: openaiApiKey,
    ...(config.openai.speechModel ? { model: config.openai.speechModel } : {}),
    ...(config.openai.voice ? { voice: config.openai.voice } : {}),
    ...(config.openai.fetch ? { fetchPort: config.openai.fetch } : {}) });
  if (config.openai.speechPrimaryFirstChunkMs !== undefined && !config.openai.speechFallbackModel) {
    throw new RangeError("speech fallback model required");
  }
  const primaryFirstChunkMs = config.openai.speechPrimaryFirstChunkMs ?? 1_500;
  const playbackOptions = config.openai.speechFallbackModel
    ? { ...config.playbackOptions,
      firstChunkDeadlineMs: config.playbackOptions?.firstChunkDeadlineMs ?? 5_000 }
    : config.playbackOptions;
  if (config.openai.speechFallbackModel &&
      (playbackOptions?.firstChunkDeadlineMs ?? 0) <= primaryFirstChunkMs) {
    throw new RangeError("speech fallback deadline unavailable");
  }
  const synthesis = config.openai.speechFallbackModel
    ? new FirstChunkFallbackSpeech({ primary: primarySynthesis,
      fallback: new OpenAISpeechSynthesis({ apiKey: openaiApiKey,
        model: config.openai.speechFallbackModel,
        ...(config.openai.voice ? { voice: config.openai.voice } : {}),
        ...(config.openai.fetch ? { fetchPort: config.openai.fetch } : {}) }),
      primaryFirstChunkMs })
    : primarySynthesis;
  const resolvers = new Map([...routes].map(([number, route]) => [number,
    createOpenAIAvailabilityIntentResolver({ apiKey: openaiApiKey,
      model: config.openai.intentModel, clinicDate: route.clinicDate,
      ...(config.openai.fetch ? { fetch: config.openai.fetch } : {}) })] as const));

  const privacy = await checkStandaloneTextDatabase(config.db);
  if (!privacy.ok) return err(privacy.error);
  if (!await config.activeCallClaims.matchesDatabase(config.db)) {
    throw new RangeError("active-call ownership database mismatch");
  }

  return ok(createTwilioIngressServer({ ingress, activeCallClaims: config.activeCallClaims,
    ...(config.health ? { health: config.health } : {}),
    ...(config.admitWebhook ? { admitWebhook: config.admitWebhook } : {}),
    async createCall(stream, send, close) {
    const route = routes.get(stream.event.dialedNumber);
    if (!route || stream.event.key.accountRef !== twilio.accountSid) throw new Error("clinic route unavailable");
    const composed = await createStandaloneTransientVoiceCall({ db: config.db, routingHost,
      stream, send, closeTransport: close, synthesis, availability: route.availability,
      approvedGreeting: route.keypadAvailabilityGreeting,
      keypadAvailabilityDate: (digit: string) => keypadAvailabilityDate(route.clinicDate, digit),
      resolveIntent: resolvers.get(route.dialedNumber)!, readiness,
      transcriptionFactory: sessionId => new OpenAIRealtimeTranscription({
        apiKey: openaiApiKey, sessionId,
        ...(transcriptionSocketFactory ? { socketFactory: transcriptionSocketFactory } : {}),
      }),
      ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
      ...(playbackOptions ? { playbackOptions } : {}),
      ...(config.now ? { now: config.now } : {}),
      ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
    });
    if (!composed.ok) throw new Error("standalone voice storage unavailable");
    return composed.value;
  } }));
}
