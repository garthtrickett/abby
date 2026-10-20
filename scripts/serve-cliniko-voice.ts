import { fileURLToPath } from "node:url";
import { ClinikoFinancialConsumer } from "../src/standalone/cliniko-financial-consumer.ts";
import { sql } from "kysely";
import { ClinikoAvailabilityReader } from "../src/cliniko/availability.ts";
import { ok } from "../src/core/model.ts";
import { unprovenReadiness } from "../src/core/readiness.ts";
import { createStandaloneClinikoSetup } from "../src/standalone/cliniko-setup-composition.ts";
import { createStandaloneClinikoVoiceServer } from "../src/standalone/cliniko-voice-server.ts";
import type { OperationalCounterStore } from "../src/voice/operational-counts.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import { PostgresActiveCallClaims } from "../src/storage/postgres-active-call-claims.ts";
import { PostgresClinikoRequestBudget } from "../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresOperationalCounters } from "../src/storage/postgres-operational-counters.ts";
import type { ClinikoVoiceServerConfig } from "../src/standalone/cliniko-voice-server.ts";
import { boundedHealthCheck } from "../src/standalone/bounded-health-check.ts";
import { clinikoCredentialFingerprint } from "../src/cliniko/read-budget.ts";
import { ClinikoVoiceClinicalHost } from "../src/standalone/cliniko-voice-clinical-host.ts";
import type { LocationScope } from "../src/core/model.ts";
export { clinicDateAt } from "../src/standalone/clinic-clock.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RangeError(`missing ${name}`);
  return value;
}

function localPort(): number {
  const raw = required("ABBY_VOICE_PORT");
  const port = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isInteger(port) ||
      port < 0 || port > 65_535 || (port === 0 && process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1")) {
    throw new RangeError("invalid ABBY_VOICE_PORT");
  }
  return port;
}

function bindingKey(): Buffer {
  const hex = required("ABBY_TWILIO_BINDING_KEY_HEX");
  if (!/^[0-9a-f]{64,}$/i.test(hex) || hex.length % 2 !== 0) {
    throw new RangeError("invalid ABBY_TWILIO_BINDING_KEY_HEX");
  }
  return Buffer.from(hex, "hex");
}

/** Provider ports and independently provisioned clinic/operational hosts. */
export type ClinicalHostContext = Readonly<{ serviceSignal: AbortSignal; db: ReturnType<typeof connectPostgres>; scope: LocationScope;
  apiKey: string; contactEmail: string; rateBudget: PostgresClinikoRequestBudget;
  contactRevision: import("../src/storage/postgres-cliniko-contact-revision.ts").PostgresClinikoContactRevision }>;
export type ClinicalRunnerLocation = Readonly<{ scope: LocationScope; spokenName: string; host: ClinikoVoiceClinicalHost }>;
export type VoiceRunnerPorts = Readonly<{
  /** Complete owner-provisioned Cliniko credential fingerprint set for this tenant/account.
   * Never discovered from caller input or selected through an environment variable. */
  clinikoCredentialAliases?: readonly string[];
  clinikoFetch?: typeof fetch;
  openaiFetch?: typeof fetch;
  transcriptionSocketFactory?: NonNullable<ClinikoVoiceServerConfig["openai"]["transcriptionSocketFactory"]>;
  speechSocketFactory?: NonNullable<ClinikoVoiceServerConfig["openai"]["speechSocketFactory"]>;
  /** Isolated synthetic runner only; never selected from an environment variable. */
  transcriptionFactory?: NonNullable<ClinikoVoiceServerConfig["transcriptionFactory"]>;
  /** Patient-free synthetic evidence, admitted only by the isolated fixture guard. */
  speechQuality?: NonNullable<ClinikoVoiceServerConfig["speechQuality"]>;
  operationalCounters?: OperationalCounterStore;
  /** A deploying host's qualified registry and matching adapter factory. */
  voiceProfiles?: NonNullable<ClinikoVoiceServerConfig["voiceProfiles"]>;
  /** Synthetic provider selection for the isolated voice runner. */
  speechModels?: Readonly<{ primary: string; fallback?: string; primaryFirstChunkMs?: number }>;
  /** Isolated synthetic runner clock; never configured through the environment. */
  syntheticClock?: NonNullable<ClinikoVoiceServerConfig["now"]>;
  /** Deployment host owns clinic approvals, verification delivery and permission.
   * No environment flag or catalogue setting can supply this authority. */
  clinicalHost?: (context: ClinicalHostContext) => ClinikoVoiceClinicalHost;
  /** Independent clinic financial grants and provider/sender provisioning. No
   * environment flag or clinical catalogue approval constructs this owner. */
  financialConsumer?: (context: ClinicalHostContext) => ClinikoFinancialConsumer | Promise<ClinikoFinancialConsumer>;
  /** Independently provisioned locations of one clinic sharing the configured number.
   * Each host retains its own approval, caller permission and private input. */
  clinicalLocations?: (context: ClinicalHostContext) => readonly ClinicalRunnerLocation[];
}>;

export async function serveClinikoVoice(ports: VoiceRunnerPorts = {}): Promise<void> {
  // Only an isolated test caller may pass before carrier fallback and clinic readiness are proven.
  const port = localPort();
  const connectionString = required("DATABASE_URL");
  const apiKey = required("ABBY_CLINIKO_API_KEY");
  const scope = { tenantId: required("ABBY_TENANT_ID"), clinicId: required("ABBY_CLINIC_ID"),
    locationId: required("ABBY_LOCATION_ID") };
  const dialedNumber = required("ABBY_TWILIO_TEST_NUMBER");
  const fallbackNumber = required("ABBY_TWILIO_FALLBACK_NUMBER");
  const accountSid = required("ABBY_TWILIO_ACCOUNT_SID");
  const routeVersion = required("ABBY_VOICE_ROUTE_VERSION");
  const contactEmail = required("ABBY_CLINIKO_CONTACT_EMAIL");
  const mode = process.env.ABBY_VOICE_TEST_MODE;
  if (mode !== undefined && mode !== "1") throw new RangeError("invalid ABBY_VOICE_TEST_MODE");
  if (ports.transcriptionFactory && (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || mode !== "1" ||
      apiKey !== "synthetic-key-au5" || !connectionString.includes("/abby_test_voice_") ||
      ports.transcriptionSocketFactory)) {
    throw new RangeError("synthetic transcription requires an isolated fixture");
  }
  if ((ports.speechQuality || ports.speechModels || ports.speechSocketFactory || ports.syntheticClock) && (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || mode !== "1" ||
      !["synthetic-key-au5", "synthetic-rotated-key-au5"].includes(apiKey) ||
      !connectionString.includes("/abby_test_voice_") || accountSid !== `AC${"1".repeat(32)}`)) {
    throw new RangeError("synthetic speech configuration requires an isolated fixture");
  }
  const operationalTokenHex = process.env.ABBY_VOICE_OPERATIONS_TOKEN_HEX;
  if (operationalTokenHex !== undefined && !/^[a-f0-9]{64}$/i.test(operationalTokenHex)) {
    throw new RangeError("invalid ABBY_VOICE_OPERATIONS_TOKEN_HEX");
  }
  const weekMode = process.env.ABBY_SEVEN_DAY_AVAILABILITY_ENABLED;
  if (weekMode !== undefined && weekMode !== "0" && weekMode !== "1") {
    throw new RangeError("invalid ABBY_SEVEN_DAY_AVAILABILITY_ENABLED");
  }
  const testCaller = mode === "1" ? required("ABBY_TWILIO_TEST_CALLER_NUMBER") : undefined;
  if (testCaller && (!/^\+[1-9]\d{1,14}$/.test(testCaller) ||
      testCaller === fallbackNumber || testCaller === dialedNumber)) {
    throw new RangeError("invalid ABBY_TWILIO_TEST_CALLER_NUMBER");
  }
  const key = bindingKey();
  const db = connectPostgres(connectionString);
  const operationalCounters = ports.operationalCounters ?? new PostgresOperationalCounters(db);
  const service = new AbortController();
  let financialConsumer: ClinikoFinancialConsumer | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;
  let retentionRun: Promise<void> | undefined;
  try {
    const healthy = boundedHealthCheck(() => sql`select 1`.execute(db));
    const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey,
      onEvent: event => {
        const kind = event === "claimRateLimited" ? "clinikoBudgetDenied" :
          event === "claimUnavailable" ? "clinikoBudgetUnavailable" : "clinikoProvider429";
        void Promise.resolve(operationalCounters.record(scope, kind)).catch(() => undefined);
      },
      ...(process.env.ABBY_CLINIKO_BUDGET_USER_REF
        ? { sharedUserRef: process.env.ABBY_CLINIKO_BUDGET_USER_REF } : {}) });
    if (ports.clinicalHost && ports.clinicalLocations) throw new RangeError("conflicting clinical runner hosts");
    const { PostgresClinikoContactRevision } = await import("../src/storage/postgres-cliniko-contact-revision.ts");
    const credentialFingerprint = clinikoCredentialFingerprint(apiKey);
    const contactRevision = new PostgresClinikoContactRevision(db, scope.tenantId, ports.clinikoCredentialAliases ?? [credentialFingerprint],
      { scope, credentialFingerprint, budget: rateBudget });
    if (!contactRevision.matches(scope.tenantId, credentialFingerprint)) throw new RangeError("configured credential missing from account aliases");
    const context = { serviceSignal: service.signal, db, scope: Object.freeze({ ...scope }), apiKey, contactEmail, rateBudget, contactRevision };
    const clinicalHost = ports.clinicalHost?.(context);
    const locations = ports.clinicalLocations?.(context)?.map(row => ({ ...row, scope: Object.freeze({ ...row.scope }) }));
    if (locations && (!locations.length || locations.length > 32 ||
        !locations.some(row => row.scope.locationId === scope.locationId) ||
        new Set(locations.map(row => row.scope.locationId)).size !== locations.length ||
        locations.some(row => row.scope.tenantId !== scope.tenantId || row.scope.clinicId !== scope.clinicId ||
          !row.scope.locationId || !row.spokenName.trim() || !(row.host instanceof ClinikoVoiceClinicalHost)))) {
      throw new RangeError("invalid clinical runner locations");
    }
    const configuredRoutes = (locations ?? [{ scope, host: clinicalHost }]).map(location => {
      const currentScope = location.scope, host = location.host?.withContactRevision(contactRevision);
      const configured = createStandaloneClinikoSetup({ db, scope: currentScope, apiKey, contactEmail, rateBudget,
        ...(host ? { runtimePolicy: host.cataloguePolicy } : {}),
        route: { accountRef: accountSid, dialedNumber, routeVersion },
        ...(ports.clinikoFetch ? { fetch: ports.clinikoFetch } : {}) });
      if (!configured.ok) throw new RangeError(`invalid Cliniko catalogue configuration: ${configured.error.kind}`);
      return { dialedNumber, scope: currentScope, routeVersion,
        ...("spokenName" in location ? { spokenName: location.spokenName } : {}),
        ...(host ? { clinicalHost: host } : {}),
        approval: configured.value.setup, rateBudget, credentialFingerprint: clinikoCredentialFingerprint(apiKey),
        availabilityForSelection: (choice: import("../src/cliniko/catalogue.ts").ClinikoSelection) => {
          const reader = ClinikoAvailabilityReader.create({ scope: currentScope, apiKey, rateBudget, contactEmail,
            onProviderUnavailable: () => operationalCounters.record(currentScope, "clinikoProviderUnavailable"),
            businessId: choice.businessId, practitionerId: choice.practitionerId,
            appointmentTypeId: choice.appointmentTypeId }, ports.clinikoFetch);
          return reader.ok ? reader.value : null;
        },
        keypadAvailabilityGreeting: { scope: currentScope, version: required("ABBY_GREETING_VERSION"),
          ownerRef: required("ABBY_GREETING_APPROVAL_OWNER_REF"), approved: true as const,
          approvedText: required("ABBY_GREETING_APPROVED_TEXT") },
        sevenDayAvailabilityEnabled: weekMode === "1" };
    });
    const provisionedFinancial = await ports.financialConsumer?.(context);
    if (ports.financialConsumer && !(provisionedFinancial instanceof ClinikoFinancialConsumer)) {
      throw new RangeError("financial consumer unavailable");
    }
    if (provisionedFinancial && !provisionedFinancial.matchesAccount(scope, credentialFingerprint, rateBudget)) {
      throw new RangeError("financial consumer account mismatch");
    }
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(connectionString, key),
      twilio: { accountSid,
        authToken: required("ABBY_TWILIO_AUTH_TOKEN"),
        publicWebhookUrl: required("ABBY_TWILIO_PUBLIC_WEBHOOK_URL"),
        publicStreamUrl: required("ABBY_TWILIO_PUBLIC_STREAM_URL"),
        fallbackNumbers: { [dialedNumber]: fallbackNumber }, bindingKey: key,
        ...(ports.syntheticClock ? { now: () => new Date(ports.syntheticClock!()) } : {}) },
      routes: configuredRoutes,
      openai: { apiKey: required("ABBY_OPENAI_API_KEY"), intentModel: required("ABBY_OPENAI_INTENT_MODEL"),
        ...(ports.openaiFetch ? { fetch: ports.openaiFetch } : {}),
        ...(ports.speechSocketFactory ? { speechSocketFactory: ports.speechSocketFactory } : {}),
        ...(ports.speechModels ? { speechModel: ports.speechModels.primary,
          ...(ports.speechModels.fallback ? { speechFallbackModel: ports.speechModels.fallback } : {}),
          ...(ports.speechModels.primaryFirstChunkMs !== undefined ? { speechPrimaryFirstChunkMs: ports.speechModels.primaryFirstChunkMs } : {}) } : {}),
        ...(ports.transcriptionSocketFactory ? { transcriptionSocketFactory: ports.transcriptionSocketFactory } : {}) },
      ...(ports.transcriptionFactory ? { transcriptionFactory: ports.transcriptionFactory } : {}),
      ...(ports.voiceProfiles ? { voiceProfiles: ports.voiceProfiles } : {}),
      ...(ports.speechQuality ? { speechQuality: ports.speechQuality } : {}),
      ...(ports.syntheticClock ? { now: ports.syntheticClock } : {}),
      readiness: testCaller ? async current => configuredRoutes.some(route => current.tenantId === route.scope.tenantId &&
        current.clinicId === route.scope.clinicId && current.locationId === route.scope.locationId)
        ? ok(true) : unprovenReadiness(current) : unprovenReadiness,
      admitWebhook: async event => !!testCaller && !!event && event.key.accountRef === accountSid &&
        event.dialedNumber === dialedNumber && event.presentedCallerNumber === testCaller && await healthy(),
      health: healthy,
      operationalCounters,
      ...(provisionedFinancial ? { stripeWebhook: provisionedFinancial.handle } : {}),
      ...(operationalTokenHex ? { operationalRead: { tokenHex: operationalTokenHex, scope } } : {}),
    });
    if (!prepared.ok) throw new Error(`standalone storage unavailable: ${prepared.error.kind}`);
    if (operationalCounters instanceof PostgresOperationalCounters) {
      await operationalCounters.pruneExpired();
      retentionTimer = setInterval(() => {
        if (retentionRun) return;
        retentionRun = operationalCounters.pruneExpired()
          .catch(() => { process.stderr.write("operational retention unavailable\n"); })
          .finally(() => { retentionRun = undefined; });
      }, 6 * 60 * 60 * 1000);
      retentionTimer.unref();
    }
    const server = prepared.value;
    if (provisionedFinancial) {
      const started = provisionedFinancial.start(service.signal);
      if (!started.ok) {
        // This listener never opened, and the supplied consumer still belongs
        // to whoever started it. Retire only our unused transport.
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw new Error("financial consumer unavailable");
      }
      financialConsumer = provisionedFinancial;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("voice listener unavailable");
    process.send?.({ kind: "listenerReady", port: address.port });
    process.stdout.write(`Abby voice local listener ready on 127.0.0.1:${address.port}; ${testCaller ? "allowlisted test calls only" : "calls disabled"}\n`);
    await new Promise<void>(resolve => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    service.abort();
    try { await financialConsumer?.close(); }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally {
    service.abort();
    try { await financialConsumer?.close(); }
    finally {
      if (retentionTimer) clearInterval(retentionTimer);
      await retentionRun;
      await operationalCounters.drain?.().catch(() => undefined);
      await db.destroy();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await serveClinikoVoice(); }
  catch (error) {
    // Never print provider payloads, environment values, or connection strings.
    const message = error instanceof Error && /^(missing|invalid) ABBY_[A-Z0-9_]+$/.test(error.message)
      ? error.message : "voice service unavailable";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
