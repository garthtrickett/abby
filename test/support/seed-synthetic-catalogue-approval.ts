import type { Kysely } from "kysely";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import type { LocationScope } from "../../src/core/model.ts";
import type Database from "../../src/storage/generated/Database.ts";
import { PostgresClinikoApprovalStore } from "../../src/storage/postgres-cliniko-approval-store.ts";

/** Test-only configuration. No real clinic actor or credential may use this path. */
export async function seedSyntheticCatalogueApproval(db: Kysely<Database>, input: Readonly<{
  scope: LocationScope;
  accountRef: string;
  dialedNumber: string;
  routeVersion: string;
  apiKey: string;
  policyVersion?: string;
  businessId?: string;
  alternatives?: readonly Readonly<{ practitionerId: string; appointmentTypeId: string }>[];
}>): Promise<void> {
  if (process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" || input.apiKey !== "synthetic-key-au5") {
    throw new Error("synthetic catalogue approval requires an isolated fixture");
  }
  const at = new Date().toISOString();
  const store = new PostgresClinikoApprovalStore(db);
  const result = await store.change(input.scope, 0, {
    scope: input.scope,
    route: { accountRef: input.accountRef, dialedNumber: input.dialedNumber, routeVersion: input.routeVersion },
    selection: { businessId: input.businessId ?? "11", practitionerId: "22", appointmentTypeId: "33",
      policyVersion: input.policyVersion ?? "0" },
    alternatives: (input.alternatives ?? []).map(choice => ({
      businessId: input.businessId ?? "11", practitionerId: choice.practitionerId,
      appointmentTypeId: choice.appointmentTypeId, policyVersion: input.policyVersion ?? "0",
    })),
    credentialFingerprint: clinikoCredentialFingerprint(input.apiKey),
    businessTimeZone: "Australia/Sydney",
    catalogueObservedAt: at, approvedBy: "synthetic-admin", approvedAt: at,
    patientActionMode: "unavailable", patientRequestMode: "unavailable",
  }, "synthetic-admin");
  if (!result.ok) throw new Error(`synthetic catalogue approval failed: ${result.error.kind}`);
}
