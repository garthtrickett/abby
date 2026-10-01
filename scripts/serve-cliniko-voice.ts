import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { ClinikoAvailabilityReader } from "../src/cliniko/availability.ts";
import { ClinikoCatalogueReader } from "../src/cliniko/catalogue.ts";
import { ClinikoCatalogueSetup } from "../src/cliniko/catalogue-setup.ts";
import { ok } from "../src/core/model.ts";
import { unprovenReadiness } from "../src/core/readiness.ts";
import { ReferenceNumberRoutingHost } from "../src/reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../src/reference/policy-store.ts";
import { createStandaloneClinikoVoiceServer } from "../src/standalone/cliniko-voice-server.ts";
import type { OperationalCounterStore } from "../src/voice/operational-counts.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import { PostgresActiveCallClaims } from "../src/storage/postgres-active-call-claims.ts";
import { PostgresClinikoRequestBudget } from "../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresClinikoApprovalStore } from "../src/storage/postgres-cliniko-approval-store.ts";
import { PostgresOperationalCounters } from "../src/storage/postgres-operational-counters.ts";
import { PostgresPolicyStore } from "../src/storage/postgres-policy-store.ts";
import type { ClinikoVoiceServerConfig } from "../src/standalone/cliniko-voice-server.ts";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new RangeError(`missing ${name}`);
  return value;
}

function localPort(): number {
  const raw = required("ABBY_VOICE_PORT");
  const port = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65_535) {
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

function clinicToday(timeZone: string): () => string {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return () => {
    const parts = Object.fromEntries(clock.formatToParts(new Date()).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

/** Test provider ports and an optional host-owned operational store. */
export type VoiceRunnerPorts = Readonly<{
  clinikoFetch?: typeof fetch;
  openaiFetch?: typeof fetch;
  transcriptionSocketFactory?: NonNullable<ClinikoVoiceServerConfig["openai"]["transcriptionSocketFactory"]>;
  operationalCounters?: OperationalCounterStore;
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
  const clinicDate = clinicToday(required("ABBY_CLINIKO_TIME_ZONE"));
  const db = connectPostgres(connectionString);
  const operationalCounters = ports.operationalCounters ?? new PostgresOperationalCounters(db);
  try {
    const healthy = async (): Promise<boolean> => {
      try { await sql`select 1`.execute(db); return true; }
      catch { return false; }
    };
    const rateBudget = new PostgresClinikoRequestBudget(db, { apiKey,
      onEvent: event => {
        const kind = event === "claimRateLimited" ? "clinikoBudgetDenied" :
          event === "claimUnavailable" ? "clinikoBudgetUnavailable" : "clinikoProvider429";
        void Promise.resolve(operationalCounters.record(scope, kind)).catch(() => undefined);
      },
      ...(process.env.ABBY_CLINIKO_BUDGET_USER_REF
        ? { sharedUserRef: process.env.ABBY_CLINIKO_BUDGET_USER_REF } : {}) });
    const availability = ClinikoAvailabilityReader.create({ scope, apiKey, rateBudget,
      contactEmail,
      businessId: required("ABBY_CLINIKO_BUSINESS_ID"),
      practitionerId: required("ABBY_CLINIKO_PRACTITIONER_ID"),
      appointmentTypeId: required("ABBY_CLINIKO_APPOINTMENT_TYPE_ID") }, ports.clinikoFetch);
    if (!availability.ok) throw new RangeError(`invalid Cliniko availability configuration: ${availability.error.kind}`);
    const catalogue = ClinikoCatalogueReader.create({ scope, apiKey, contactEmail, rateBudget }, ports.clinikoFetch);
    if (!catalogue.ok) throw new RangeError(`invalid Cliniko catalogue configuration: ${catalogue.error.kind}`);
    const approval = new ClinikoCatalogueSetup(catalogue.value,
      new ReferenceNumberRoutingHost([{ accountRef: accountSid, dialedNumber,
        ...scope, routeVersion }]),
      new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", unprovenReadiness,
        false, "standaloneMinimal"), new PostgresClinikoApprovalStore(db));
    const prepared = await createStandaloneClinikoVoiceServer({ db,
      activeCallClaims: new PostgresActiveCallClaims(connectionString, key),
      twilio: { accountSid,
        authToken: required("ABBY_TWILIO_AUTH_TOKEN"),
        publicWebhookUrl: required("ABBY_TWILIO_PUBLIC_WEBHOOK_URL"),
        publicStreamUrl: required("ABBY_TWILIO_PUBLIC_STREAM_URL"),
        fallbackNumbers: { [dialedNumber]: fallbackNumber }, bindingKey: key },
      routes: [{ dialedNumber, scope, routeVersion,
        availability: availability.value, approval, rateBudget, clinicDate,
        alternativeAvailability: choice => {
          const reader = ClinikoAvailabilityReader.create({ scope, apiKey, rateBudget, contactEmail,
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
        ...(ports.transcriptionSocketFactory ? { transcriptionSocketFactory: ports.transcriptionSocketFactory } : {}) },
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
    const server = prepared.value;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    process.stdout.write(`Abby voice local listener ready on 127.0.0.1:${port}; ${testCaller ? "allowlisted test calls only" : "calls disabled"}\n`);
    await new Promise<void>(resolve => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } finally {
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
