import type { Server } from "node:http";
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
import { checkStandaloneTextDatabase } from "../storage/standalone-privacy-preflight.ts";
import type { StandalonePrivacyPreflightFailure } from "../storage/standalone-privacy-preflight.ts";
import { createStandaloneClinikoSetup } from "./cliniko-setup-composition.ts";
import { createHostAuthenticatedDashboardServer } from "./dashboard/server.ts";
import type { HostDashboardIdentity } from "./dashboard/server.ts";

export type ClinikoAdminDashboardConfig = Readonly<{
  db: Kysely<Database>;
  scope: LocationScope;
  route: ClinikoSetupRoute;
  apiKey: string;
  contactEmail: string;
  sharedBudgetUserRef?: string;
  publicOrigin: string;
  resolveActor: HostDashboardIdentity["resolveActor"];
  readSpeechGate?: HostDashboardIdentity["readSpeechGate"];
  unauthorized?: HostDashboardIdentity["unauthorized"];
  bundlePath: string;
  fetch?: typeof fetch;
  now?: () => string;
}>;

export type ClinikoAdminDashboardFailure = ClinikoCatalogueFailure | StandalonePrivacyPreflightFailure |
  Readonly<{ kind: "dashboardUnavailable" }>;

/** The host owns identity and listener lifetime; this composition owns only clinic-safe configuration. */
export async function createStandaloneClinikoAdminDashboard(config: ClinikoAdminDashboardConfig):
  Promise<Result<Server, ClinikoAdminDashboardFailure>> {
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
    rateBudget, ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.now ? { now: config.now } : {}) });
  if (!configured.ok) return configured;
  const reception = new TextReception(new MemoryLedger(), configured.value.policy,
    new ReferenceClinicHost([], []));
  try {
    const server = await createHostAuthenticatedDashboardServer({ publicOrigin: config.publicOrigin,
      surface: "availabilitySetup",
      resolveActor: config.resolveActor,
      ...(config.readSpeechGate ? { readSpeechGate: config.readSpeechGate } : {}),
      ...(config.unauthorized ? { unauthorized: config.unauthorized } : {}),
      gatewayFor: actor => {
        if (actor.role === "agent" || actor.scope.tenantId !== scope.tenantId ||
            actor.scope.clinicId !== scope.clinicId ||
            actor.scope.locationId !== scope.locationId) throw new RangeError("clinic admin scope unavailable");
        return new CommandGateway(actor, configured.value.policy, reception, undefined, undefined,
          undefined, undefined, undefined, configured.value.setup);
      },
    }, config.bundlePath);
    return ok(server);
  } catch (error) {
    return err({ kind: error instanceof RangeError ? "invalidConfig" : "dashboardUnavailable" });
  }
}
