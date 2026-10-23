import { OpenAIVoiceProfileHost } from "../voice/openai-voice-profile.ts";
import type { OpenAIVoiceProfileConfig } from "../voice/openai-voice-profile.ts";
import type { VoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import type { SpeechAdapterFactory } from "../voice/call-speech-binding.ts";
import type { Server } from "node:http";
import type { TwilioIngressServerConfig } from "../voice/twilio-ingress-server.ts";
import type { Kysely } from "kysely";
import { ClinikoAvailabilityReader } from "../cliniko/availability.ts";
import { ClinikoApprovedAvailabilitySearch } from "../cliniko/approved-availability-search.ts";
import type { ClinikoSelection } from "../cliniko/catalogue.ts";
import type { ClinikoCatalogueSetup, ClinikoSelectionApproval, ClinikoSetupRoute } from "../cliniko/catalogue-setup.ts";
import { isClinikoApprovalState } from "../cliniko/catalogue-setup.ts";
import { validGreetingShape } from "../core/greeting.ts";
import { err, ok } from "../core/model.ts";
import type { ApprovedGreeting, LocationScope, Result } from "../core/model.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import { ReferenceNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import type Database from "../storage/generated/Database.ts";
import { PostgresActiveCallClaims } from "../storage/postgres-active-call-claims.ts";
import { PostgresClinikoRequestBudget } from "../storage/postgres-cliniko-request-budget.ts";
import { checkStandaloneTextDatabase } from "../storage/standalone-privacy-preflight.ts";
import { boundedHealthCheck } from "./bounded-health-check.ts";
import type { StandalonePrivacyPreflightFailure } from "../storage/standalone-privacy-preflight.ts";
import type { MediaTurnOptions, TranscriptionPort } from "../voice/media-turn-controller.ts";
import type { OpenAIRealtimeTranscriptionConfig } from "../voice/openai-realtime-transcription.ts";
import { OpenAISpeechProvider, realtimeSpeechModel } from "../voice/openai-speech-provider.ts";
import type { StreamedPlaybackOptions } from "../voice/streamed-playback-port.ts";
import { createTwilioIngressServer } from "../voice/twilio-ingress-server.ts";
import { TwilioSignedIngress } from "../voice/twilio-signed-ingress.ts";
import type { TwilioSignedIngressConfig } from "../voice/twilio-signed-ingress.ts";
import type { AuthenticatedInboundCall } from "../voice/admission.ts";
import { createOpenAIAvailabilityIntentResolver } from "./openai-availability-intent.ts";
import { clinicDateAt } from "./clinic-clock.ts";
import { keypadAvailabilityRange } from "./keypad-availability.ts";
import { validKeypadGreetingText } from "./keypad-greeting.ts";
import { StandaloneOperationalCounters } from "./operational-counters.ts";
import type { OperationalCounterKind, OperationalCounterStore } from "../voice/operational-counts.ts";
import { createStandaloneTransientVoiceCall } from "./transient-voice-composition.ts";
import { ClinikoVoiceClinicalHost } from "./cliniko-voice-clinical-host.ts";
import { ClinikoClinicalLocationGroup } from "./cliniko-clinical-location-group.ts";
import { sameScope } from "./appointment-change-authority.ts";

type ClinikoVoiceRouteBase = Readonly<{
  dialedNumber: string;
  scope: LocationScope;
  /** Required public name when locations share a number. */
  spokenName?: string;
  routeVersion: string;
  approval: Pick<ClinikoCatalogueSetup, "readApprovedRoute">;
  rateBudget: PostgresClinikoRequestBudget;
  /** Required clinic approval: Realtime finals cannot yet authorize speech-led availability. */
  keypadAvailabilityGreeting: ApprovedGreeting;
  /** Must agree with the approved keypad wording; absent means disabled. */
  sevenDayAvailabilityEnabled?: boolean;
  /** Independently provisioned clinic host; does not grant admission readiness. */
  clinicalHost?: ClinikoVoiceClinicalHost;
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

function validKeypadGreeting(greeting: unknown, scope: LocationScope, sevenDayEnabled: boolean): greeting is ApprovedGreeting {
  return validGreetingShape(greeting, scope) && validKeypadGreetingText(greeting.approvedText, sevenDayEnabled);
}

export type ClinikoVoiceServerConfig = Readonly<{
  /** Independent financial owner, provisioned explicitly rather than by call admission. */
  stripeWebhook?: TwilioIngressServerConfig["stripeWebhook"];
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
    fetch?: typeof fetch;
    transcriptionSocketFactory?: OpenAIRealtimeTranscriptionConfig["socketFactory"];
    speechSocketFactory?: OpenAIVoiceProfileConfig["speechSocketFactory"];
  }>;
  /** Host-supplied transcription; the runnable server permits this only in an isolated test fixture. */
  transcriptionFactory?: (sessionId: string) => TranscriptionPort;
  voiceProfiles?: VoiceProfileRegistry & SpeechAdapterFactory;
  speechQuality?: OpenAIVoiceProfileConfig["quality"];
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
  const routes = new Map<string, ClinikoVoiceRoute[]>();
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
        !route.rateBudget.matchesDatabase(config.db) ||
        !Object.hasOwn(twilio.fallbackNumbers, route.dialedNumber)) {
      throw new RangeError("invalid clinic voice route");
    }
    const greeting = route.keypadAvailabilityGreeting;
    if (route.clinicalHost !== undefined && (!(route.clinicalHost instanceof ClinikoVoiceClinicalHost) ||
        !route.clinicalHost.usesBudget(route.rateBudget))) {
      throw new RangeError("invalid clinical voice host");
    }
    if ((route.sevenDayAvailabilityEnabled !== undefined && typeof route.sevenDayAvailabilityEnabled !== "boolean") ||
        !validKeypadGreeting(greeting, route.scope, route.sevenDayAvailabilityEnabled === true)) {
      throw new RangeError("invalid keypad availability greeting");
    }
    const group = routes.get(route.dialedNumber) ?? [];
    if (group.some(member => sameScope(member.scope, route.scope))) throw new RangeError("duplicate clinic voice location");
    group.push({ ...route, scope: structuredClone(route.scope), keypadAvailabilityGreeting: structuredClone(greeting) });
    routes.set(route.dialedNumber, group);
  }
  if (routes.size !== fallbackNumbers.length) throw new RangeError("incomplete clinic voice routes");
  for (const group of routes.values()) {
    if (group.length > 32 || group.length > 1 && group.some(route => !route.clinicalHost?.locationServiceSource ||
        !route.spokenName?.trim() || route.scope.tenantId !== group[0]!.scope.tenantId ||
        route.scope.clinicId !== group[0]!.scope.clinicId || route.routeVersion !== group[0]!.routeVersion)) {
      throw new RangeError("invalid shared-number clinical locations");
    }
  }
  const allRoutes = [...routes.values()].flat();
  const checkBudgetSchema = allRoutes[0]!.rateBudget.schemaCompatible.bind(allRoutes[0]!.rateBudget);
  const budgetSchemaReady = boundedHealthCheck(async () => {
    if (!await checkBudgetSchema()) throw new Error("shared budget storage unavailable");
  });
  const operationalRead = config.operationalRead ? { tokenHex: config.operationalRead.tokenHex,
    scope: structuredClone(config.operationalRead.scope) } : undefined;
  if (operationalRead && !allRoutes.some(route =>
      route.scope.tenantId === operationalRead.scope.tenantId &&
      route.scope.clinicId === operationalRead.scope.clinicId &&
      route.scope.locationId === operationalRead.scope.locationId)) {
    throw new RangeError("operational read scope unavailable");
  }
  const operationalCounters = config.operationalCounters ?? new StandaloneOperationalCounters();
  const ingress = new TwilioSignedIngress(twilio);
  const routingHost = new ReferenceNumberRoutingHost(allRoutes.map(route => ({
    accountRef: twilio.accountSid, dialedNumber: route.dialedNumber,
    ...route.scope, routeVersion: route.routeVersion,
    ...(route.spokenName ? { spokenName: route.spokenName } : {}),
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
      if (route.clinicalHost && !route.clinicalHost.matches(approval)) return null;
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
  if ("voice" in config.openai) throw new RangeError("use clinic voice preferences instead of a global voice");
  new OpenAISpeechProvider({ apiKey: openaiApiKey, model: config.openai.speechModel ?? "gpt-4o-mini-tts",
    ...(config.openai.fetch ? { fetch: config.openai.fetch } : {}),
    ...(config.openai.speechSocketFactory ? { speechSocketFactory: config.openai.speechSocketFactory } : {}) });
  if (config.openai.speechPrimaryFirstChunkMs !== undefined && !config.openai.speechFallbackModel) {
    throw new RangeError("speech fallback model required");
  }
  const primaryFirstChunkMs = config.openai.speechPrimaryFirstChunkMs ?? 1_500;
  const playbackOptions = config.openai.speechFallbackModel || config.openai.speechModel === realtimeSpeechModel
    ? { ...config.playbackOptions,
      firstChunkDeadlineMs: config.playbackOptions?.firstChunkDeadlineMs ?? 5_000 }
    : config.playbackOptions;
  if (config.openai.speechFallbackModel &&
      (playbackOptions?.firstChunkDeadlineMs ?? 0) <= primaryFirstChunkMs) {
    throw new RangeError("speech fallback deadline unavailable");
  }
  const voiceProfiles = config.voiceProfiles ?? new OpenAIVoiceProfileHost({ apiKey: openaiApiKey,
    mode: allRoutes.some(route => route.clinicalHost) ? "conversation" : "keypadAvailability", ...(config.transcriptionFactory ? { customTranscription: {
      version: "host-transcription.v1", create: config.transcriptionFactory } } : {}), ...(config.openai.speechModel ? { primaryModel: config.openai.speechModel } : {}),
    ...(config.openai.speechFallbackModel ? { fallbackModel: config.openai.speechFallbackModel, primaryFirstChunkMs } : {}),
    runtime: { ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}), ...(playbackOptions ? { playbackOptions } : {}) },
    ...(config.openai.fetch ? { fetch: config.openai.fetch } : {}),
    ...(transcriptionSocketFactory ? { socketFactory: transcriptionSocketFactory } : {}),
    ...(config.openai.speechSocketFactory ? { speechSocketFactory: config.openai.speechSocketFactory } : {}),
    ...(config.speechQuality ? { quality: config.speechQuality } : {}),
  });
  if (!await budgetSchemaReady()) return err({ kind: "storageFailure" });
  const privacy = await checkStandaloneTextDatabase(config.db);
  if (!privacy.ok) return err(privacy.error);
  if (!await config.activeCallClaims.matchesDatabase(config.db)) {
    throw new RangeError("active-call ownership database mismatch");
  }

  return ok(createTwilioIngressServer({ ingress, activeCallClaims: config.activeCallClaims,
    ...(config.stripeWebhook !== undefined ? { stripeWebhook: config.stripeWebhook } : {}),
    ...(operationalRead ? { operationalRead: { tokenHex: operationalRead.tokenHex,
      snapshot: () => operationalCounters.snapshot(operationalRead.scope),
      ...(operationalCounters.daily ? { daily: () => operationalCounters.daily!(operationalRead.scope) } : {}) } } : {}),
    ...(config.health ? { health: config.health } : {}),
    admitWebhook: async event => {
      if (!event || event.key.accountRef !== twilio.accountSid) return false;
      const group = routes.get(event.dialedNumber);
      const route = group?.[0];
      if (!route || !group) return false;
      if (config.admitWebhook && !await config.admitWebhook(event).catch(() => false)) {
        count(route.scope, "admissionDenied");
        return false;
      }
      if (!await budgetSchemaReady()) {
        count(route.scope, "admissionDenied");
        return false;
      }
      const approved = (await Promise.all(group.map(approvedRoute))).every(Boolean);
      if (!approved) count(route.scope, "admissionDenied");
      return approved;
    },
    async createCall(stream, send, close) {
    const group = routes.get(stream.event.dialedNumber);
    const route = group?.[0];
    if (!route || !group || stream.event.key.accountRef !== twilio.accountSid) throw new Error("clinic route unavailable");
    if (!await budgetSchemaReady()) {
      count(route.scope, "admissionDenied");
      throw new Error("shared budget storage unavailable");
    }
    const approvals = await Promise.all(group.map(approvedRoute));
    const approved = approvals[0];
    if (!approved || approvals.some(value => !value)) {
      count(route.scope, "admissionDenied");
      throw new Error("clinic catalogue approval unavailable");
    }
    const availability = new ClinikoApprovedAvailabilitySearch(approved.readers,
      config.now, approved.approval.businessTimeZone);
    const classifyIntent = createOpenAIAvailabilityIntentResolver({ apiKey: openaiApiKey,
      model: config.openai.intentModel, clinicDate: approved.clinicDate,
      ...(config.openai.fetch ? { fetch: config.openai.fetch } : {}) });
    const locations = group.length > 1 ? new ClinikoClinicalLocationGroup(group.map((member, index) => ({
      scope: member.scope, host: member.clinicalHost!, approval: approvals[index]!.approval,
    })), async scope => {
      const member = group.find(member => sameScope(member.scope, scope));
      return member ? (await approvedRoute(member))?.approval ?? null : null;
    }) : undefined;
    let diagnosticScope = route.scope;
    let ownerStarted = false;
    const recordOwner = (scope: LocationScope) => {
      diagnosticScope = scope;
      if (!ownerStarted) { ownerStarted = true; count(scope, "callOwnerStarted"); }
    };
    const composed = await createStandaloneTransientVoiceCall({ db: config.db, routingHost,
      ...(locations ? { onLocationBound: recordOwner } : {}),
      ...(locations ? { expectedPolicyVersions: locations.policyVersions,
        locationServiceSources: locations.serviceSources.map(source => ({ ...source, ...(config.now ? { clock: config.now } : {}) })) }
        : { expectedPolicyVersion: approved.approval.selection.policyVersion }),
      stream, send, closeTransport: close, voiceProfiles,
      ...(!locations ? { availability, approvedGreeting: route.clinicalHost?.greeting ?? route.keypadAvailabilityGreeting } : {}),
      greetingValidator: greeting => {
        const member = greeting && group.find(member => sameScope(member.scope, greeting.scope));
        return !!member && (member.clinicalHost
          ? validGreetingShape(greeting, member.scope) && JSON.stringify(greeting) === JSON.stringify(member.clinicalHost.greeting)
          : validKeypadGreeting(greeting, member.scope, member.sevenDayAvailabilityEnabled === true));
      },
      ...(locations ? { clinicalWorkflow: locations.workflow() } : route.clinicalHost ? { clinicalWorkflow: route.clinicalHost.workflow(approved.approval) } : {
        keypadAvailabilityRange: (digit: string) => keypadAvailabilityRange(approved.clinicDate, digit,
          route.sevenDayAvailabilityEnabled === true) }),
      resolveIntent: async (turn, signal) => {
        try {
          const result = await classifyIntent(turn, signal);
          if (!signal?.aborted && !result.ok) count(route.scope, "intentClassificationUnavailable");
          return result;
        } catch {
          if (!signal?.aborted) count(route.scope, "intentClassificationUnavailable");
          return err({ kind: "intentUnavailable" });
        }
      }, readiness,
      ...(config.mediaOptions ? { mediaOptions: config.mediaOptions } : {}),
      ...(playbackOptions ? { playbackOptions } : {}),
      ...(config.now ? { now: config.now } : {}),
      ...(config.monotonicNow ? { monotonicNow: config.monotonicNow } : {}),
    });
    if (!composed.ok) throw new Error("standalone voice storage unavailable");
    const call = composed.value;
    if (!locations) recordOwner(route.scope);
    let failed = false;
    let ended = false;
    const markEnded = () => {
      if (!ended) { ended = true; count(diagnosticScope, "callEnded"); }
    };
    return {
      async receive(raw: string) {
        const result = await call.receive(raw);
        if (!result.ok && !failed) { failed = true; count(diagnosticScope, "voiceFailure"); }
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
