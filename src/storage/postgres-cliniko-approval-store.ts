import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { isClinikoApprovalState } from "../cliniko/catalogue-setup.ts";
import type { ClinikoApprovalState, ClinikoApprovalStore, ClinikoSelectionApproval, ClinikoSetupFailure } from "../cliniko/catalogue-setup.ts";
import type Database from "./generated/Database.ts";
import type { ClinikoCatalogueApprovals, ClinikoCatalogueApprovalsClinicId, ClinikoCatalogueApprovalsLocationId,
  ClinikoCatalogueApprovalsTenantId, ClinikoCatalogueApprovalsVersion } from "./generated/public/ClinikoCatalogueApprovals.ts";

const validRef = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const validScope = (scope: LocationScope): boolean =>
  !!scope && validRef(scope.tenantId) && validRef(scope.clinicId) && validRef(scope.locationId);
const sameScope = (left: LocationScope, right: LocationScope): boolean =>
  left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;

const ids = (scope: LocationScope) => ({
  tenant_id: scope.tenantId as ClinikoCatalogueApprovalsTenantId,
  clinic_id: scope.clinicId as ClinikoCatalogueApprovalsClinicId,
  location_id: scope.locationId as ClinikoCatalogueApprovalsLocationId,
});

const emptyApproval = {
  account_ref: null, dialed_number: null, route_version: null, business_id: null,
  practitioner_id: null, appointment_type_id: null, policy_version: null,
  credential_fingerprint: null, catalogue_observed_at: null, approved_at: null,
} as const;

function decode(row: ClinikoCatalogueApprovals | undefined, scope: LocationScope):
  Result<ClinikoApprovalState, ClinikoSetupFailure> {
  if (!row) return ok({ version: 0, approval: null });
  if (!Number.isSafeInteger(row.version) || row.version < 0 ||
      row.tenant_id !== scope.tenantId || row.clinic_id !== scope.clinicId || row.location_id !== scope.locationId ||
      !validRef(row.changed_by) || !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) {
    return err({ kind: "storageFailure" });
  }
  if (!row.approved) {
    if (Object.keys(emptyApproval).some(key => row[key as keyof typeof emptyApproval] !== null)) {
      return err({ kind: "storageFailure" });
    }
    return ok({ version: row.version, approval: null });
  }
  if (!(row.catalogue_observed_at instanceof Date) || !Number.isFinite(row.catalogue_observed_at.getTime()) ||
      !(row.approved_at instanceof Date) || !Number.isFinite(row.approved_at.getTime())) {
    return err({ kind: "storageFailure" });
  }
  const approval: ClinikoSelectionApproval = {
    scope: { ...scope }, route: { accountRef: row.account_ref!, dialedNumber: row.dialed_number!,
      routeVersion: row.route_version! },
    selection: { businessId: row.business_id!, practitionerId: row.practitioner_id!,
      appointmentTypeId: row.appointment_type_id!, policyVersion: row.policy_version! },
    credentialFingerprint: row.credential_fingerprint!,
    catalogueObservedAt: row.catalogue_observed_at.toISOString(),
    approvedBy: row.changed_by, approvedAt: row.approved_at.toISOString(),
    patientActionMode: "unavailable", patientRequestMode: "unavailable",
  };
  const state = { version: row.version, approval };
  return isClinikoApprovalState(state) ? ok(state) : err({ kind: "storageFailure" });
}

/** Append-only, clinic-scoped CAS history. The API credential is never stored. */
export class PostgresClinikoApprovalStore implements ClinikoApprovalStore {
  private readonly db: Kysely<Database>;
  constructor(db: Kysely<Database>) { this.db = db; }

  matchesDatabase(db: Kysely<Database>): boolean { return this.db === db; }

  async read(scope: LocationScope): Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>> {
    if (!validScope(scope)) return err({ kind: "invalid" });
    try {
      const row = await this.db.selectFrom("cliniko_catalogue_approvals").selectAll()
        .where("tenant_id", "=", scope.tenantId as ClinikoCatalogueApprovalsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinikoCatalogueApprovalsClinicId)
        .where("location_id", "=", scope.locationId as ClinikoCatalogueApprovalsLocationId)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      return decode(row, scope);
    } catch { return err({ kind: "storageFailure" }); }
  }

  async change(scope: LocationScope, expectedVersion: number, approval: ClinikoSelectionApproval | null, changedBy: string):
    Promise<Result<ClinikoApprovalState, ClinikoSetupFailure>> {
    if (!validScope(scope) || !validRef(changedBy) || !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 || expectedVersion >= 2_147_483_647 ||
        (approval !== null && (!isClinikoApprovalState({ version: 1, approval }) ||
          !sameScope(scope, approval.scope) || approval.approvedBy !== changedBy))) return err({ kind: "invalid" });
    const key = ids(scope);
    try {
      return await this.db.transaction().execute(async trx => {
        await trx.insertInto("cliniko_catalogue_approvals").values({ ...key,
          version: 0 as ClinikoCatalogueApprovalsVersion, approved: false, ...emptyApproval,
          changed_by: "system" }).onConflict(conflict =>
          conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("cliniko_catalogue_approvals").select("version")
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
          .where("location_id", "=", key.location_id).where("version", "=", 0 as ClinikoCatalogueApprovalsVersion)
          .forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("cliniko_catalogue_approvals").selectAll()
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
          .where("location_id", "=", key.location_id).orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const current = decode(latest, scope);
        if (!current.ok) return current;
        if (current.value.version !== expectedVersion) return err({ kind: "versionConflict" });
        await trx.insertInto("cliniko_catalogue_approvals").values({ ...key,
          version: latest.version + 1 as ClinikoCatalogueApprovalsVersion,
          approved: approval !== null,
          ...(approval ? {
            account_ref: approval.route.accountRef, dialed_number: approval.route.dialedNumber,
            route_version: approval.route.routeVersion, business_id: approval.selection.businessId,
            practitioner_id: approval.selection.practitionerId,
            appointment_type_id: approval.selection.appointmentTypeId,
            policy_version: approval.selection.policyVersion,
            credential_fingerprint: approval.credentialFingerprint,
            catalogue_observed_at: approval.catalogueObservedAt, approved_at: approval.approvedAt,
          } : emptyApproval), changed_by: changedBy }).execute();
        return ok({ version: latest.version + 1, approval: approval ? structuredClone(approval) : null });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
