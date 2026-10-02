import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, LocationScope, Result } from "../core/model.ts";
import type { PolicyFailure } from "../core/host.ts";
import { resolveStaffedDestination, validStaffedDestinationChange, validStaffedDestinationRef, validStaffedDestinationScope } from "../core/staffed-destination.ts";
import type { StaffedDestinationAuditPage, StaffedDestinationHost } from "../core/staffed-destination.ts";
import type Database from "./generated/Database.ts";
import type { ClinicSettingsClinicId, ClinicSettingsLocationId, ClinicSettingsTenantId, ClinicSettingsVersion } from "./generated/public/ClinicSettings.ts";

/** The enclosing policy store owns its privacy profile; this module owns route CAS and audit. */
export type StaffedDestinationPolicyCodec = Readonly<{
  initial(scope: LocationScope): CallPolicy;
  decode(value: unknown, scope: LocationScope, version: number): Result<CallPolicy, PolicyFailure>;
  encode(policy: CallPolicy): unknown;
}>;

export class PostgresStaffedDestinationSettingStore {
  private readonly db: Kysely<Database>;
  private readonly codec: StaffedDestinationPolicyCodec;
  private readonly host: StaffedDestinationHost;

  constructor(db: Kysely<Database>, codec: StaffedDestinationPolicyCodec, host: StaffedDestinationHost) {
    this.db = db; this.codec = codec; this.host = host;
  }

  async change(scope: LocationScope, expectedVersion: string, destinationRef: string | null,
               actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (!validStaffedDestinationChange(scope, expectedVersion, destinationRef, actorRef)) return err({ kind: "invalidValue" });
    const ids = { tenant_id: scope.tenantId as ClinicSettingsTenantId, clinic_id: scope.clinicId as ClinicSettingsClinicId,
      location_id: scope.locationId as ClinicSettingsLocationId };
    try {
      const observed = await this.db.selectFrom("clinic_settings").select("version")
        .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      if (String(observed?.version ?? 0) !== expectedVersion) return err({ kind: "versionConflict" });
      if (destinationRef !== null) {
        const resolved = await resolveStaffedDestination(this.host, scope, destinationRef);
        if (!resolved.ok) return resolved;
      }
      return await this.db.transaction().execute(async trx => {
        const initial = this.codec.initial(scope);
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion,
          policy: this.codec.encode(initial) })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .where("version", "=", 0 as ClinicSettingsVersion).forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        if (String(latest.version) !== expectedVersion) return err({ kind: "versionConflict" });
        const decoded = this.codec.decode(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        const { transferDestinationRef: previous, transferDestinationVersion: hostVersion, ...base } = decoded.value;
        void hostVersion;
        const next: CallPolicy = { ...base, policyVersion: String(latest.version + 1),
          ...(destinationRef === null ? {} : { transferDestinationRef: destinationRef }) };
        await trx.insertInto("clinic_settings").values({ ...ids, version: latest.version + 1 as ClinicSettingsVersion,
          policy: this.codec.encode(next), setting_kind: "staffedDestination", previous_staffed_destination_ref: previous ?? null,
          changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        return ok(next);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async listChanges(scope: LocationScope, afterVersion?: number): Promise<Result<StaffedDestinationAuditPage, PolicyFailure>> {
    if (!validStaffedDestinationScope(scope) || (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0))) {
      return err({ kind: "invalidValue" });
    }
    try {
      const rows = await this.db.selectFrom("clinic_settings")
        .select(["version", "policy", "previous_staffed_destination_ref", "changed_by", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId).where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId).where("setting_kind", "=", "staffedDestination")
        .where("version", ">", Math.min(afterVersion ?? 0, 2_147_483_647) as ClinicSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: StaffedDestinationAuditPage["entries"][number][] = [];
      for (const row of rows) {
        const policy = this.codec.decode(row.policy, scope, row.version);
        if (!policy.ok || !validStaffedDestinationRef(row.changed_by) ||
            (row.previous_staffed_destination_ref !== null && !validStaffedDestinationRef(row.previous_staffed_destination_ref)) ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), destinationRef: policy.value.transferDestinationRef ?? null,
          previousDestinationRef: row.previous_staffed_destination_ref, actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
