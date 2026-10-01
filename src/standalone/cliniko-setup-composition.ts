import type { Kysely } from "kysely";
import { ClinikoCatalogueReader } from "../cliniko/catalogue.ts";
import type { ClinikoCatalogueFailure } from "../cliniko/catalogue.ts";
import { ClinikoCatalogueSetup } from "../cliniko/catalogue-setup.ts";
import type { ClinikoSetupRoute } from "../cliniko/catalogue-setup.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { unprovenReadiness } from "../core/readiness.ts";
import { ReferenceNumberRoutingHost } from "../reference/clinic-number-routing.ts";
import { referenceDefaultPolicy } from "../reference/policy-store.ts";
import type Database from "../storage/generated/Database.ts";
import { PostgresClinikoRequestBudget } from "../storage/postgres-cliniko-request-budget.ts";
import { PostgresClinikoApprovalStore } from "../storage/postgres-cliniko-approval-store.ts";
import { PostgresPolicyStore } from "../storage/postgres-policy-store.ts";

export type StandaloneClinikoSetupConfig = Readonly<{
  db: Kysely<Database>;
  scope: LocationScope;
  route: ClinikoSetupRoute;
  apiKey: string;
  contactEmail: string;
  rateBudget: PostgresClinikoRequestBudget;
  fetch?: typeof fetch;
  now?: () => string;
}>;

/** Both admin and voice use this exact route, policy, credential and approval binding. */
export function createStandaloneClinikoSetup(config: StandaloneClinikoSetupConfig):
  Result<Readonly<{ setup: ClinikoCatalogueSetup; policy: PostgresPolicyStore }>, ClinikoCatalogueFailure> {
  if (!(config.rateBudget instanceof PostgresClinikoRequestBudget) ||
      !config.rateBudget.matchesDatabase(config.db)) return err({ kind: "invalidConfig" });
  const catalogue = ClinikoCatalogueReader.create({ scope: config.scope, apiKey: config.apiKey,
    contactEmail: config.contactEmail, rateBudget: config.rateBudget }, config.fetch);
  if (!catalogue.ok) return catalogue;
  if (!config.rateBudget.matchesCredentialFingerprint(catalogue.value.credentialFingerprint())) {
    return err({ kind: "invalidConfig" });
  }
  try {
    const policy = new PostgresPolicyStore(config.db, referenceDefaultPolicy, "unavailable",
      unprovenReadiness, false, "standaloneMinimal");
    const routing = new ReferenceNumberRoutingHost([{ ...config.scope, ...config.route }]);
    const setup = new ClinikoCatalogueSetup(catalogue.value, routing, policy,
      new PostgresClinikoApprovalStore(config.db), config.now);
    return ok({ setup, policy });
  } catch { return err({ kind: "invalidConfig" }); }
}
