import type { Server } from "node:http";
import type { Kysely } from "kysely";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import type { LocationScope } from "../core/model.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import { ReferenceNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import type Database from "../storage/generated/Database.ts";
import type { MediaTurnOptions } from "../voice/media-turn-controller.ts";
import { OpenAIRealtimeTranscription } from "../voice/openai-realtime-transcription.ts";
import type { OpenAIRealtimeTranscriptionConfig } from "../voice/openai-realtime-transcription.ts";
import { OpenAISpeechSynthesis } from "../voice/openai-speech-synthesis.ts";
import { createTwilioIngressServer } from "../voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../voice/twilio-signed-ingress.ts";
import type { TwilioSignedIngressConfig } from "../voice/twilio-signed-ingress.ts";
import { createOpenAIAvailabilityIntentResolver } from "./openai-availability-intent.ts";
import { createStandaloneTransientVoiceCall } from "./transient-voice-composition.ts";

export type ClinikoVoiceRoute = Readonly<{
  dialedNumber: string;
  scope: LocationScope;
  routeVersion: string;
  availability: ClinikoAvailabilityReader;
  /** Today's YYYY-MM-DD date in this clinic's local time zone. */
  clinicDate: () => string;
}>;

export type ClinikoVoiceServerConfig = Readonly<{
  db: Kysely<Database>;
  twilio: TwilioSignedIngressConfig;
  routes: readonly ClinikoVoiceRoute[];
  openai: Readonly<{
    apiKey: string;
    intentModel: string;
    speechModel?: string;
    voice?: string;
    fetch?: typeof fetch;
    transcriptionSocketFactory?: OpenAIRealtimeTranscriptionConfig["socketFactory"];
  }>;
  readiness: AutomationReadiness;
  mediaOptions?: MediaTurnOptions;
  now?: () => string;
  monotonicNow?: () => number;
}>;

/** Connects authenticated Twilio media to one transient Cliniko-only call per socket. */
export function createStandaloneClinikoVoiceServer(config: ClinikoVoiceServerConfig): Server {
  if (!config.routes.length || config.routes.length > 1_000) throw new RangeError("invalid clinic voice routes");
  const twilio = { ...config.twilio, bindingKey: new Uint8Array(config.twilio.bindingKey),
    fallbackNumbers: { ...config.twilio.fallbackNumbers } };
  const fallbackNumbers = Object.keys(twilio.fallbackNumbers);
  const routes = new Map<string, ClinikoVoiceRoute>();
  for (const route of config.routes) {
    if (!route.scope.tenantId || !route.scope.clinicId || !route.scope.locationId ||
        !route.routeVersion?.trim() || !(route.availability instanceof ClinikoAvailabilityReader) ||
        typeof route.clinicDate !== "function" || routes.has(route.dialedNumber) ||
        !Object.hasOwn(twilio.fallbackNumbers, route.dialedNumber)) {
      throw new RangeError("invalid clinic voice route");
    }
    routes.set(route.dialedNumber, { ...route, scope: structuredClone(route.scope) });
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
  const synthesis = new OpenAISpeechSynthesis({ apiKey: openaiApiKey,
    ...(config.openai.speechModel ? { model: config.openai.speechModel } : {}),
    ...(config.openai.voice ? { voice: config.openai.voice } : {}),
    ...(config.openai.fetch ? { fetchPort: config.openai.fetch } : {}) });
  const resolvers = new Map([...routes].map(([number, route]) => [number,
    createOpenAIAvailabilityIntentResolver({ apiKey: openaiApiKey,
      model: config.openai.intentModel, clinicDate: route.clinicDate,
      ...(config.openai.fetch ? { fetch: config.openai.fetch } : {}) })] as const));

  return createTwilioIngressServer({ ingress, async createCall(stream, send) {
    const route = routes.get(stream.event.dialedNumber);
    if (!route || stream.event.key.accountRef !== twilio.accountSid) throw new Error("clinic route unavailable");
    const composed = await createStandaloneTransientVoiceCall({ db: config.db, routingHost,
      stream, send, synthesis, availability: route.availability,
      resolveIntent: resolvers.get(route.dialedNumber)!, readiness,
      transcriptionFactory: sessionId => new OpenAIRealtimeTranscription({
        apiKey: openaiApiKey, sessionId,
        ...(transcriptionSocketFactory ? { socketFactory: transcriptionSocketFactory } : {}),
      }),
      ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
      ...(config.now ? { now: config.now } : {}),
      ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
    });
    if (!composed.ok) throw new Error("standalone voice storage unavailable");
    return composed.value;
  } });
}
