import { fileURLToPath } from "node:url";
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

/** Test provider ports and an optional host-owned operational store. */
export type VoiceRunnerPorts = Readonly<{
  clinikoFetch?: typeof fetch;
  openaiFetch?: typeof fetch;
  transcriptionSocketFactory?: NonNullable<ClinikoVoiceServerConfig["openai"]["transcriptionSocketFactory"]>;
  speechSocketFactory?: NonNullable<ClinikoVoiceServerConfig["openai"]["speechSocketFactory"]>;
  /** Isolated synthetic runner only; never selected from an environment variable. */
  transcriptionFactory?: NonNullable<ClinikoVoiceServerConfig["transcriptionFactory"]>;
  /** Patient-free synthetic evidence, admitted only by the isolated fixture guard. */
  speechQuality?: NonNullable<ClinikoVoiceServerConfig["speechQuality"]>;
  operationalCounters?: OperationalCounterStore;
  /** Synthetic provider selection for the isolated voice runner. */
  speechModels?: Readonly<{ primary: string; fallback?: string; primaryFirstChunkMs?: number }>;
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
  if ((ports.speechQuality || ports.speechModels || ports.speechSocketFactory) && (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || mode !== "1" ||
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
    const configured = createStandaloneClinikoSetup({ db, scope, apiKey, contactEmail, rateBudget,
      route: { accountRef: accountSid, dialedNumber, routeVersion },
      ...(ports.clinikoFetch ? { fetch: ports.clinikoFetch } : {}) });
    if (!configured.ok) throw new RangeError(`invalid Cliniko catalogue configuration: ${configured.error.kind}`);
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(connectionString, key),
      twilio: { accountSid,
        authToken: required("ABBY_TWILIO_AUTH_TOKEN"),
        publicWebhookUrl: required("ABBY_TWILIO_PUBLIC_WEBHOOK_URL"),
        publicStreamUrl: required("ABBY_TWILIO_PUBLIC_STREAM_URL"),
        fallbackNumbers: { [dialedNumber]: fallbackNumber }, bindingKey: key },
      routes: [{ dialedNumber, scope, routeVersion,
        approval: configured.value.setup, rateBudget, credentialFingerprint: clinikoCredentialFingerprint(apiKey),
        availabilityForSelection: choice => {
          const reader = ClinikoAvailabilityReader.create({ scope, apiKey, rateBudget, contactEmail,
            onProviderUnavailable: () => operationalCounters.record(scope, "clinikoProviderUnavailable"),
            businessId: choice.businessId, practitionerId: choice.practitionerId,
            appointmentTypeId: choice.appointmentTypeId }, ports.clinikoFetch);
          return reader.ok ? reader.value : null;
        },
        keypadAvailabilityGreeting: { scope, version: required("ABBY_GREETING_VERSION"),
          ownerRef: required("ABBY_GREETING_APPROVAL_OWNER_REF"), approved: true,
          approvedText: required("ABBY_GREETING_APPROVED_TEXT") },
        sevenDayAvailabilityEnabled: weekMode === "1" }],
      openai: { apiKey: required("ABBY_OPENAI_API_KEY"), intentModel: required("ABBY_OPENAI_INTENT_MODEL"),
        ...(ports.openaiFetch ? { fetch: ports.openaiFetch } : {}),
        ...(ports.speechSocketFactory ? { speechSocketFactory: ports.speechSocketFactory } : {}),
        ...(ports.speechModels ? { speechModel: ports.speechModels.primary,
          ...(ports.speechModels.fallback ? { speechFallbackModel: ports.speechModels.fallback } : {}),
          ...(ports.speechModels.primaryFirstChunkMs !== undefined ? { speechPrimaryFirstChunkMs: ports.speechModels.primaryFirstChunkMs } : {}) } : {}),
        ...(ports.transcriptionSocketFactory ? { transcriptionSocketFactory: ports.transcriptionSocketFactory } : {}) },
      ...(ports.transcriptionFactory ? { transcriptionFactory: ports.transcriptionFactory } : {}),
      ...(ports.speechQuality ? { speechQuality: ports.speechQuality } : {}),
      readiness: testCaller ? async current => current.tenantId === scope.tenantId &&
        current.clinicId === scope.clinicId && current.locationId === scope.locationId
        ? ok(true) : unprovenReadiness(current) : unprovenReadiness,
      admitWebhook: async event => !!testCaller && !!event && event.key.accountRef === accountSid &&
        event.dialedNumber === dialedNumber && event.presentedCallerNumber === testCaller && await healthy(),
      health: healthy,
      operationalCounters,
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
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally {
    if (retentionTimer) clearInterval(retentionTimer);
    await retentionRun;
    await operationalCounters.drain?.().catch(() => undefined);
    await db.destroy();
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
