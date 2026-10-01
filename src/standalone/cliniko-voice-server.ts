import type { Server } from "node:http";
import type { Kysely } from "kysely";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { ClinikoApprovedAvailabilitySearch } from "../cliniko/approved-availability-search.ts";
import type { ClinikoSelection } from "../cliniko/catalogue.ts";
import type { ClinikoCatalogueSetup, ClinikoSelectionApproval, ClinikoSetupRoute } from "../cliniko/catalogue-setup.ts";
import { isClinikoApprovalState } from "../cliniko/catalogue-setup.ts";
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
import { clinicDateAt } from "./clinic-clock.ts";
import { keypadAvailabilityRange } from "./keypad-availability.ts";
import { StandaloneOperationalCounters } from "./operational-counters.ts";
import type { OperationalCounterKind, OperationalCounterStore } from "../voice/operational-counts.ts";
import { createStandaloneTransientVoiceCall } from "./transient-voice-composition.ts";

type ClinikoVoiceRouteBase = Readonly<{
  dialedNumber: string;
  scope: LocationScope;
  routeVersion: string;
  approval: Pick<ClinikoCatalogueSetup, "readApprovedRoute">;
  rateBudget: PostgresClinikoRequestBudget;
  /** Required clinic approval: Realtime finals cannot yet authorize speech-led availability. */
  keypadAvailabilityGreeting: ApprovedGreeting;
  /** Must agree with the approved keypad wording; absent means disabled. */
  sevenDayAvailabilityEnabled?: boolean;
}>;

export type ClinikoVoiceRoute = ClinikoVoiceRouteBase & (
  Readonly<{
    /** The live runner binds every call to the current approved primary and alternatives. */
    credentialFingerprint: string;
    availabilityForSelection: (selection: ClinikoSelection) => ClinikoAvailabilityReader | null;
  }> |
  Readonly<{
    /** Legacy fixed-reader composition retained for isolated synthetic callers. */
    availability: ClinikoAvailabilityReader;
    alternativeAvailability?: (selection: ClinikoSelection) => ClinikoAvailabilityReader | null;
    clinicDate: () => string;
    timeZone: string;
  }>
);

function isDynamicRoute(route: ClinikoVoiceRoute): route is ClinikoVoiceRouteBase &
    Readonly<{ credentialFingerprint: string;
      availabilityForSelection: (selection: ClinikoSelection) => ClinikoAvailabilityReader | null }> {
  return "availabilityForSelection" in route;
}

const keypadInstructions = "Press 1 for possible times today. Press 2 for possible times tomorrow.";
const sevenDayInstructions = "Press 3 for possible times over the next week.";

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
  /** Aggregate fixed-code diagnostics; the owner controls who may read them. */
  operationalCounters?: OperationalCounterStore;
  /** One configured clinic's aggregate counters, readable only with this token. */
  operationalRead?: Readonly<{ tokenHex: string; scope: LocationScope }>;
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
    if (!(route.rateBudget instanceof PostgresClinikoRequestBudget)) {
      throw new RangeError("invalid clinic voice route");
    }
    const dynamic = isDynamicRoute(route);
    const readerBindingValid = dynamic
      ? typeof route.availabilityForSelection === "function" &&
        typeof route.credentialFingerprint === "string" &&
        route.rateBudget.matchesCredentialFingerprint(route.credentialFingerprint) &&
        !("availability" in route) && !("clinicDate" in route) && !("timeZone" in route)
      : route.availability instanceof ClinikoAvailabilityReader &&
        route.availability.matchesScope(route.scope) &&
        route.availability.usesBudget(route.rateBudget) &&
        route.rateBudget.matchesCredentialFingerprint(route.availability.credentialFingerprint()) &&
        (route.alternativeAvailability === undefined || typeof route.alternativeAvailability === "function") &&
        typeof route.clinicDate === "function" && typeof route.timeZone === "string" && !!route.timeZone;
    if (!route.scope.tenantId || !route.scope.clinicId || !route.scope.locationId ||
        !route.routeVersion?.trim() || !readerBindingValid ||
        !route.approval || typeof route.approval.readApprovedRoute !== "function" ||
        !route.rateBudget.matchesDatabase(config.db) || routes.has(route.dialedNumber) ||
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
        !greeting.approvedText.includes(keypadInstructions) ||
        (route.sevenDayAvailabilityEnabled !== undefined && typeof route.sevenDayAvailabilityEnabled !== "boolean") ||
        greeting.approvedText.includes(sevenDayInstructions) !== (route.sevenDayAvailabilityEnabled === true)) {
      throw new RangeError("invalid keypad availability greeting");
    }
    routes.set(route.dialedNumber, { ...route, scope: structuredClone(route.scope),
      keypadAvailabilityGreeting: structuredClone(greeting) });
  }
  if (routes.size !== fallbackNumbers.length) throw new RangeError("incomplete clinic voice routes");
  const operationalRead = config.operationalRead ? { tokenHex: config.operationalRead.tokenHex,
    scope: structuredClone(config.operationalRead.scope) } : undefined;
  if (operationalRead && ![...routes.values()].some(route =>
      route.scope.tenantId === operationalRead.scope.tenantId &&
      route.scope.clinicId === operationalRead.scope.clinicId &&
      route.scope.locationId === operationalRead.scope.locationId)) {
    throw new RangeError("operational read scope unavailable");
  }
  const operationalCounters = config.operationalCounters ?? new StandaloneOperationalCounters();
  const ingress = new TwilioSignedIngress(twilio);
  const routingHost = new ReferenceNumberRoutingHost([...routes.values()].map(route => ({
    accountRef: twilio.accountSid, dialedNumber: route.dialedNumber,
    ...route.scope, routeVersion: route.routeVersion,
  })));
  const approvedRoute = async (route: ClinikoVoiceRoute): Promise<Readonly<{
    approval: ClinikoSelectionApproval; readers: readonly ClinikoAvailabilityReader[];
    clinicDate: () => string;
  }> | null> => {
    const binding: ClinikoSetupRoute = { accountRef: twilio.accountSid,
      dialedNumber: route.dialedNumber, routeVersion: route.routeVersion };
    try {
      const result = await route.approval.readApprovedRoute(route.scope, binding);
      if (!result.ok) return null;
      const approval = result.value;
      const dynamic = isDynamicRoute(route);
      if (!isClinikoApprovalState({ version: 1, approval }) ||
          !approval.scope || approval.scope.tenantId !== route.scope.tenantId ||
          approval.scope.clinicId !== route.scope.clinicId || approval.scope.locationId !== route.scope.locationId ||
          !approval.route || approval.route.accountRef !== binding.accountRef ||
          approval.route.dialedNumber !== binding.dialedNumber || approval.route.routeVersion !== binding.routeVersion ||
          !approval.selection || !approval.selection.policyVersion?.trim() ||
          approval.patientActionMode !== "unavailable" || approval.patientRequestMode !== "unavailable" ||
          !Array.isArray(approval.alternatives) || approval.alternatives.length > 2) return null;
      if (!dynamic && (approval.businessTimeZone !== route.timeZone ||
          !route.availability.matchesSelection(route.scope, { ...approval.selection,
            credentialFingerprint: approval.credentialFingerprint }) ||
          (approval.alternatives.length > 0 && !route.alternativeAvailability))) return null;
      if (dynamic && approval.credentialFingerprint !== route.credentialFingerprint) return null;
      const readers: ClinikoAvailabilityReader[] = [];
      const choices = dynamic
        ? [approval.selection, ...approval.alternatives] : approval.alternatives;
      for (const choice of choices) {
        const reader = dynamic
          ? route.availabilityForSelection(choice) : route.alternativeAvailability?.(choice);
        if (!(reader instanceof ClinikoAvailabilityReader) ||
            !reader.matchesSelection(route.scope, { ...choice,
              credentialFingerprint: approval.credentialFingerprint }) ||
            !reader.usesBudget(route.rateBudget) ||
            !route.rateBudget.matchesCredentialFingerprint(reader.credentialFingerprint())) return null;
        readers.push(reader);
      }
      return { approval, readers: dynamic ? readers : [route.availability, ...readers],
        clinicDate: dynamic
          ? () => clinicDateAt(approval.businessTimeZone, new Date(config.now?.() ?? Date.now()))
          : route.clinicDate };
    } catch { return null; }
  };
  const openaiApiKey = config.openai.apiKey;
  const transcriptionSocketFactory = config.openai.transcriptionSocketFactory;
  const readiness = config.readiness;
  const count = (scope: LocationScope, kind: OperationalCounterKind): void => {
    try { void Promise.resolve(operationalCounters.record(scope, kind)).catch(() => undefined); }
    catch { /* operational diagnostics cannot alter a call */ }
  };
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
  const privacy = await checkStandaloneTextDatabase(config.db);
  if (!privacy.ok) return err(privacy.error);
  if (!await config.activeCallClaims.matchesDatabase(config.db)) {
    throw new RangeError("active-call ownership database mismatch");
  }

  return ok(createTwilioIngressServer({ ingress, activeCallClaims: config.activeCallClaims,
    ...(operationalRead ? { operationalRead: { tokenHex: operationalRead.tokenHex,
      snapshot: () => operationalCounters.snapshot(operationalRead.scope) } } : {}),
    ...(config.health ? { health: config.health } : {}),
    admitWebhook: async event => {
      if (!event || event.key.accountRef !== twilio.accountSid) return false;
      const route = routes.get(event.dialedNumber);
      if (!route) return false;
      if (config.admitWebhook && !await config.admitWebhook(event).catch(() => false)) {
        count(route.scope, "admissionDenied");
        return false;
      }
      const approved = !!await approvedRoute(route);
      if (!approved) count(route.scope, "admissionDenied");
      return approved;
    },
    async createCall(stream, send, close) {
    const route = routes.get(stream.event.dialedNumber);
    if (!route || stream.event.key.accountRef !== twilio.accountSid) throw new Error("clinic route unavailable");
    const approved = await approvedRoute(route);
    if (!approved) {
      count(route.scope, "admissionDenied");
      throw new Error("clinic catalogue approval unavailable");
    }
    const availability = new ClinikoApprovedAvailabilitySearch(approved.readers,
      config.now, approved.approval.businessTimeZone);
    const composed = await createStandaloneTransientVoiceCall({ db: config.db, routingHost,
      expectedPolicyVersion: approved.approval.selection.policyVersion,
      stream, send, closeTransport: close, synthesis,
      availability,
      approvedGreeting: route.keypadAvailabilityGreeting,
      keypadAvailabilityRange: (digit: string) => keypadAvailabilityRange(approved.clinicDate, digit,
        route.sevenDayAvailabilityEnabled === true),
      resolveIntent: createOpenAIAvailabilityIntentResolver({ apiKey: openaiApiKey,
        model: config.openai.intentModel, clinicDate: approved.clinicDate,
        ...(config.openai.fetch ? { fetch: config.openai.fetch } : {}) }), readiness,
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
    const call = composed.value;
    count(route.scope, "callOwnerStarted");
    let failed = false;
    let ended = false;
    const markEnded = () => {
      if (!ended) { ended = true; count(route.scope, "callEnded"); }
    };
    return {
      async receive(raw: string) {
        const result = await call.receive(raw);
        if (!result.ok && !failed) { failed = true; count(route.scope, "voiceFailure"); }
        if (!result.ok) markEnded();
        return result;
      },
      async disconnect() {
        try { await call.disconnect(); }
        finally { markEnded(); }
      },
    };
  } }));
}
