import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { BookingSettingAuditEntry, BookingSettingAuditPage, PolicyFailure, PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, CapabilityMode, LocationScope, Result } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import type { ClinicSettingsClinicId, ClinicSettingsLocationId, ClinicSettingsTenantId, ClinicSettingsVersion } from "./generated/public/ClinicSettings.ts";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function decodePolicy(value: unknown, scope: LocationScope, version: number): Result<CallPolicy, PolicyFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err({ kind: "storageFailure" });
  const policy = value as CallPolicy;
  if (!policy.scope || !sameScope(policy.scope, scope) || policy.policyVersion !== String(version) || typeof policy.bookingEnabled !== "boolean" || !policy.capabilities || !["execute", "requestOnly", "unavailable"].includes(policy.capabilities.transfer) || !policy.staffDestination || !policy.operatorQueue) return err({ kind: "storageFailure" });
  return ok(structuredClone(policy));
}

export class PostgresPolicyStore implements PolicyStore {
  private readonly db: Kysely<Database>;
  private readonly defaultPolicy: (scope: LocationScope) => CallPolicy;
  private readonly hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly">;

  constructor(db: Kysely<Database>, defaultPolicy: (scope: LocationScope) => CallPolicy, hostBookingMode: Extract<CapabilityMode, "execute" | "requestOnly"> = "execute") {
    this.db = db;
    this.defaultPolicy = defaultPolicy;
    this.hostBookingMode = hostBookingMode;
  }

  private effective(policy: CallPolicy): CallPolicy {
    return { ...policy, capabilities: { ...policy.capabilities, book: policy.bookingEnabled ? this.hostBookingMode : "unavailable" } };
  }

  async read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>> {
    try {
      const row = await this.db.selectFrom("clinic_settings").select(["version", "policy"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      const decoded = row ? decodePolicy(row.policy, scope, row.version) : ok(this.defaultPolicy(scope));
      return decoded.ok ? ok(this.effective(decoded.value)) : decoded;
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256) return err({ kind: "invalidValue" });
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = {
          tenant_id: scope.tenantId as ClinicSettingsTenantId,
          clinic_id: scope.clinicId as ClinicSettingsClinicId,
          location_id: scope.locationId as ClinicSettingsLocationId,
        };
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion, policy: this.defaultPolicy(scope) })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .where("version", "=", 0 as ClinicSettingsVersion).forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = decodePolicy(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        if (decoded.value.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
        const next: CallPolicy = {
          ...decoded.value,
          policyVersion: String(latest.version + 1),
          bookingEnabled: enabled,
          capabilities: { ...decoded.value.capabilities, book: enabled ? this.hostBookingMode : "unavailable" },
        };
        await trx.insertInto("clinic_settings").values({ ...ids, version: latest.version + 1 as ClinicSettingsVersion, policy: next,
          changed_by: actorRef, previous_booking_enabled: decoded.value.bookingEnabled, changed_at: sql`clock_timestamp()` }).execute();
        return ok(structuredClone(next));
      });
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async listBookingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<BookingSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    try {
      const rows = await this.db.selectFrom("clinic_settings")
        .select(["version", "policy", "changed_by", "previous_booking_enabled", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .where("version", ">", (afterVersion ?? 0) as ClinicSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: BookingSettingAuditEntry[] = [];
      for (const row of rows) {
        const decoded = decodePolicy(row.policy, scope, row.version);
        if (!decoded.ok) return decoded;
        const metadata = [row.changed_by, row.previous_booking_enabled, row.changed_at];
        if (metadata.every(value => value === null)) {
          entries.push({ version: String(row.version), enabled: decoded.value.bookingEnabled, provenance: "legacyUnattributed" });
          continue;
        }
        if (typeof row.changed_by !== "string" || !row.changed_by.trim() || typeof row.previous_booking_enabled !== "boolean" ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: decoded.value.bookingEnabled, provenance: "recorded",
          actorRef: row.changed_by, previousEnabled: row.previous_booking_enabled, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch {
      return err({ kind: "storageFailure" });
    }
  }
}
