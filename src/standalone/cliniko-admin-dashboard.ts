import type { VoiceProfileRegistry } from "../core/voice-profile-registry.ts";
import { createServer } from "node:http";
import type { RequestListener, Server } from "node:http";
import type { Kysely } from "kysely";
import type { ClinikoCatalogueFailure } from "../cliniko/catalogue.ts";
import type { ClinikoSetupRoute } from "../cliniko/catalogue-setup.ts";
import { MemoryLedger } from "../core/ledger.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { ReferenceClinicHost } from "../reference/clinic-host.ts";
import { CommandGateway } from "../reference/command-gateway.ts";
import { TextReception } from "../reference/text-reception.ts";
import type Database from "../storage/generated/Database.ts";
import { PostgresClinikoRequestBudget } from "../storage/postgres-cliniko-request-budget.ts";
import { PostgresOperationalCounters } from "../storage/postgres-operational-counters.ts";
import { checkStandaloneTextDatabase } from "../storage/standalone-privacy-preflight.ts";
import type { StandalonePrivacyPreflightFailure } from "../storage/standalone-privacy-preflight.ts";
import { createStandaloneClinikoSetup } from "./cliniko-setup-composition.ts";
import { validKeypadGreetingText } from "./keypad-greeting.ts";
import { createHostAuthenticatedDashboardRequestHandler } from "./dashboard/server.ts";
import type { HostDashboardIdentity } from "./dashboard/server.ts";

export type ClinikoAdminDashboardConfig = Readonly<{
  db: Kysely<Database>;
  scope: LocationScope;
  route: ClinikoSetupRoute;
  apiKey: string;
  contactEmail: string;
  sevenDayAvailabilityEnabled?: boolean;
  sharedBudgetUserRef?: string;
  publicOrigin: string;
  resolveActor: HostDashboardIdentity["resolveActor"];
  readSpeechGate?: HostDashboardIdentity["readSpeechGate"];
  unauthorized?: HostDashboardIdentity["unauthorized"];
  signOutPath?: string;
  bundlePath: string;
  voiceProfiles?: VoiceProfileRegistry;
  fetch?: typeof fetch;
  now?: () => string;
}>;

export type ClinikoAdminDashboardFailure = ClinikoCatalogueFailure | StandalonePrivacyPreflightFailure |
  Readonly<{ kind: "dashboardUnavailable" }>;

/** The host owns identity and listener lifetime; this composition owns only clinic-safe configuration. */
export async function createStandaloneClinikoAdminDashboard(config: ClinikoAdminDashboardConfig):
  Promise<Result<Server, ClinikoAdminDashboardFailure>> {
  const handler = await createStandaloneClinikoAdminDashboardHandler(config);
  return handler.ok ? ok(createServer(handler.value)) : handler;
}

/** Shares the real scoped composition with a standalone sign-in router, without altering server listeners. */
export async function createStandaloneClinikoAdminDashboardHandler(config: ClinikoAdminDashboardConfig):
  Promise<Result<RequestListener, ClinikoAdminDashboardFailure>> {
  if (config.sevenDayAvailabilityEnabled !== undefined &&
      typeof config.sevenDayAvailabilityEnabled !== "boolean") return err({ kind: "invalidConfig" });
  const scope = structuredClone(config.scope);
  const privacy = await checkStandaloneTextDatabase(config.db);
  if (!privacy.ok) return privacy;
  let rateBudget: PostgresClinikoRequestBudget;
  try {
    rateBudget = new PostgresClinikoRequestBudget(config.db, { apiKey: config.apiKey,
      ...(config.sharedBudgetUserRef ? { sharedUserRef: config.sharedBudgetUserRef } : {}) });
  } catch { return err({ kind: "invalidConfig" }); }
  const configured = createStandaloneClinikoSetup({ db: config.db, scope,
    route: config.route, apiKey: config.apiKey, contactEmail: config.contactEmail,
    rateBudget, ...(config.voiceProfiles ? { voiceProfiles: config.voiceProfiles } : {}), ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.now ? { now: config.now } : {}) });
  if (!configured.ok) return configured;
  const reception = new TextReception(new MemoryLedger(), configured.value.policy,
    new ReferenceClinicHost([], []));
  const operationalDaily = new PostgresOperationalCounters(config.db);
  try {
    const handler = await createHostAuthenticatedDashboardRequestHandler({ publicOrigin: config.publicOrigin,
      surface: "availabilitySetup",
      greetingTextValidator: text => validKeypadGreetingText(text, config.sevenDayAvailabilityEnabled === true),
      resolveActor: config.resolveActor,
      ...(config.readSpeechGate ? { readSpeechGate: config.readSpeechGate } : {}),
      ...(config.unauthorized ? { unauthorized: config.unauthorized } : {}),
      ...(config.signOutPath ? { signOutPath: config.signOutPath } : {}),
      gatewayFor: actor => {
        if (actor.role === "agent" || actor.scope.tenantId !== scope.tenantId ||
            actor.scope.clinicId !== scope.clinicId ||
            actor.scope.locationId !== scope.locationId) throw new RangeError("clinic admin scope unavailable");
        return new CommandGateway(actor, configured.value.policy, reception, undefined, undefined,
          undefined, undefined, undefined, configured.value.setup, operationalDaily);
      },
    }, config.bundlePath);
    return ok(handler);
  } catch (error) {
    return err({ kind: error instanceof RangeError ? "invalidConfig" : "dashboardUnavailable" });
  }
}
