import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { AutomationSettingAuditEntry, AutomationSettingAuditPage, BookingSettingAuditEntry, BookingSettingAuditPage, PolicyFailure, PolicyStore } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, CapabilityMode, LocationScope, Result } from "../core/model.ts";
import { READINESS_REQUIREMENTS, unprovenReadiness } from "../core/readiness.ts";
import type { AutomationReadiness } from "../core/readiness.ts";
import type Database from "./generated/Database.ts";
import type { ClinicAutomationClinicId, ClinicAutomationTenantId, ClinicAutomationVersion } from "./generated/public/ClinicAutomation.ts";
import type { ClinicSettingsClinicId, ClinicSettingsLocationId, ClinicSettingsTenantId, ClinicSettingsVersion } from "./generated/public/ClinicSettings.ts";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

type StoredStandalonePolicy = Readonly<{ scope: LocationScope; policyVersion: string; bookingEnabled: boolean }>;
const standaloneScopeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validStandaloneScope(scope: LocationScope): boolean {
  return [scope.tenantId, scope.clinicId, scope.locationId].every(value => typeof value === "string" && standaloneScopeId.test(value));
}

function standalonePolicy(scope: LocationScope, version: number, bookingEnabled: boolean): StoredStandalonePolicy {
  return { scope: { tenantId: scope.tenantId, clinicId: scope.clinicId, locationId: scope.locationId },
    policyVersion: String(version), bookingEnabled };
}

export function isStoredStandalonePolicy(value: unknown, scope: LocationScope, version: number): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const stored = value as Record<string, unknown>;
  if (Object.keys(stored).sort().join(",") !== "bookingEnabled,policyVersion,scope" ||
      typeof stored.bookingEnabled !== "boolean" || stored.policyVersion !== String(version) ||
      typeof stored.scope !== "object" || stored.scope === null || Array.isArray(stored.scope)) return false;
  const storedScope = stored.scope as Record<string, unknown>;
  if (Object.keys(storedScope).sort().join(",") !== "clinicId,locationId,tenantId" ||
      !sameScope(storedScope as LocationScope, scope)) return false;
  return true;
}

function decodeStandalonePolicy(value: unknown, scope: LocationScope, version: number,
                                defaultPolicy: (scope: LocationScope) => CallPolicy): Result<CallPolicy, PolicyFailure> {
  if (!isStoredStandalonePolicy(value, scope, version)) return err({ kind: "storageFailure" });
  const stored = value as Record<string, unknown>;
  const base = defaultPolicy(scope);
  return ok({ ...base, scope: { ...scope }, policyVersion: String(version), bookingEnabled: stored.bookingEnabled as boolean });
}

function decodePolicy(value: unknown, scope: LocationScope, version: number): Result<CallPolicy, PolicyFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err({ kind: "storageFailure" });
  const policy = value as CallPolicy;
  if (!policy.scope || !sameScope(policy.scope, scope) || policy.policyVersion !== String(version) ||
      (policy.automationEnabled !== undefined && typeof policy.automationEnabled !== "boolean") ||
      (policy.staffWorkEnabled !== undefined && typeof policy.staffWorkEnabled !== "boolean") ||
      typeof policy.bookingEnabled !== "boolean" || !policy.capabilities ||
      !["execute", "requestOnly", "unavailable"].includes(policy.capabilities.transfer) ||
      !policy.staffDestination || !policy.operatorQueue) return err({ kind: "storageFailure" });
  return ok(structuredClone({ ...policy, automationVersion: "0", automationEnabled: false }));
}

export class PostgresPolicyStore implements PolicyStore {
  private readonly db: Kysely<Database>;
  private readonly defaultPolicy: (scope: LocationScope) => CallPolicy;
  private readonly hostBookingMode: CapabilityMode;
  private readonly readiness: AutomationReadiness;
  private readonly staffWorkEnabled: boolean;
  private readonly storageMode: "unsafeReference" | "standaloneMinimal";

  /** Rich policy storage is synthetic-only and requires the explicit unsafeReference mode. */
  constructor(db: Kysely<Database>, defaultPolicy: (scope: LocationScope) => CallPolicy, hostBookingMode: CapabilityMode = "unavailable", readiness: AutomationReadiness = unprovenReadiness,
              staffWorkEnabled = false, storageMode: "unsafeReference" | "standaloneMinimal" = "standaloneMinimal") {
    this.db = db;
    this.defaultPolicy = defaultPolicy;
    this.hostBookingMode = hostBookingMode;
    this.readiness = readiness;
    this.staffWorkEnabled = staffWorkEnabled;
    this.storageMode = storageMode;
  }

  private decode(value: unknown, scope: LocationScope, version: number): Result<CallPolicy, PolicyFailure> {
    return this.storageMode === "standaloneMinimal"
      ? decodeStandalonePolicy(value, scope, version, this.defaultPolicy) : decodePolicy(value, scope, version);
  }

  private effective(policy: CallPolicy, automation?: Readonly<{ version: number; enabled: boolean }>): CallPolicy {
    const patientModes = this.hostBookingMode === "unavailable"
      ? { cancel: "unavailable", reschedule: "unavailable", intake: "unavailable" } as const : {};
    return { ...policy, staffWorkEnabled: this.staffWorkEnabled,
      automationVersion: String(automation?.version ?? 0), automationEnabled: automation?.enabled ?? false,
      capabilities: { ...policy.capabilities, ...patientModes,
        book: policy.bookingEnabled ? this.hostBookingMode : "unavailable",
        transfer: this.staffWorkEnabled ? policy.capabilities.transfer : "unavailable" } };
  }

  async read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>> {
    if (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope)) return err({ kind: "invalidValue" });
    try {
      const local = this.db.selectFrom("clinic_settings").select(["version", "policy"])
        .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
        .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      const clinic = this.db.selectFrom("clinic_automation").select(["version", "enabled"])
        .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      const [row, automation] = await Promise.all([local, clinic]);
      const decoded = row ? this.decode(row.policy, scope, row.version) : ok(this.defaultPolicy(scope));
      return decoded.ok ? ok(this.effective(decoded.value, automation)) : decoded;
    } catch {
      return err({ kind: "storageFailure" });
    }
  }

  async changeAutomationEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) return err({ kind: "invalidValue" });
    try {
      const current = await this.db.selectFrom("clinic_automation").select("version")
        .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      if (String(current?.version ?? 0) !== expectedVersion) return err({ kind: "versionConflict" });
    } catch { return err({ kind: "storageFailure" }); }
    if (enabled) {
      let ready: Awaited<ReturnType<AutomationReadiness>>;
      try { ready = await this.readiness(scope); }
      catch { return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS }); }
      if (!ready.ok) return ready;
      if (ready.value !== true) return err({ kind: "readinessFailed", missing: READINESS_REQUIREMENTS });
    }
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = {
          tenant_id: scope.tenantId as ClinicAutomationTenantId,
          clinic_id: scope.clinicId as ClinicAutomationClinicId,
        };
        await trx.insertInto("clinic_automation").values({ ...ids, version: 0 as ClinicAutomationVersion, enabled: false })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_automation").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .where("version", "=", 0 as ClinicAutomationVersion).forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        if (String(latest.version) !== expectedVersion) return err({ kind: "versionConflict" });
        const local = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", scope.tenantId as ClinicSettingsTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicSettingsClinicId)
          .where("location_id", "=", scope.locationId as ClinicSettingsLocationId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        const decoded = local ? this.decode(local.policy, scope, local.version) : ok(this.defaultPolicy(scope));
        if (!decoded.ok) throw new Error("invalid location policy");
        await trx.insertInto("clinic_automation").values({ ...ids, version: latest.version + 1 as ClinicAutomationVersion,
          enabled, changed_by: actorRef, previous_enabled: latest.enabled, changed_at: sql`clock_timestamp()` }).execute();
        return ok(this.effective(decoded.value, { version: latest.version + 1, enabled }));
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async listAutomationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AutomationSettingAuditPage, PolicyFailure>> {
    if (afterVersion !== undefined && (!Number.isSafeInteger(afterVersion) || afterVersion < 0)) return err({ kind: "invalidValue" });
    try {
      const rows = await this.db.selectFrom("clinic_automation")
        .select(["version", "enabled", "changed_by", "previous_enabled", "changed_at"])
        .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
        .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
        .where("version", ">", (afterVersion ?? 0) as ClinicAutomationVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: AutomationSettingAuditEntry[] = [];
      for (const row of rows) {
        if (typeof row.changed_by !== "string" || !row.changed_by.trim() || typeof row.previous_enabled !== "boolean" ||
            !(row.changed_at instanceof Date) || !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: row.enabled,
          previousEnabled: row.previous_enabled, actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>> {
    if (typeof enabled !== "boolean" || typeof actorRef !== "string" || !actorRef.trim() || actorRef.length > 256 ||
        (this.storageMode === "standaloneMinimal" && !validStandaloneScope(scope))) return err({ kind: "invalidValue" });
    try {
      return await this.db.transaction().execute(async trx => {
        const ids = {
          tenant_id: scope.tenantId as ClinicSettingsTenantId,
          clinic_id: scope.clinicId as ClinicSettingsClinicId,
          location_id: scope.locationId as ClinicSettingsLocationId,
        };
        const initialPolicy = this.defaultPolicy(scope);
        await trx.insertInto("clinic_settings").values({ ...ids, version: 0 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal" ? standalonePolicy(scope, 0, initialPolicy.bookingEnabled) : initialPolicy })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "location_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_settings").select("version")
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .where("version", "=", 0 as ClinicSettingsVersion).forUpdate().executeTakeFirstOrThrow();
        const latest = await trx.selectFrom("clinic_settings").select(["version", "policy"])
          .where("tenant_id", "=", ids.tenant_id).where("clinic_id", "=", ids.clinic_id).where("location_id", "=", ids.location_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        const decoded = this.decode(latest.policy, scope, latest.version);
        if (!decoded.ok) return decoded;
        if (decoded.value.policyVersion !== expectedVersion) return err({ kind: "versionConflict" });
        const next: CallPolicy = {
          ...decoded.value,
          policyVersion: String(latest.version + 1),
          bookingEnabled: enabled,
          capabilities: { ...decoded.value.capabilities, book: enabled ? this.hostBookingMode : "unavailable" },
        };
        await trx.insertInto("clinic_settings").values({ ...ids, version: latest.version + 1 as ClinicSettingsVersion,
          policy: this.storageMode === "standaloneMinimal" ? standalonePolicy(scope, latest.version + 1, enabled) : next,
          changed_by: actorRef, previous_booking_enabled: decoded.value.bookingEnabled, changed_at: sql`clock_timestamp()` }).execute();
        const automation = await trx.selectFrom("clinic_automation").select(["version", "enabled"])
          .where("tenant_id", "=", scope.tenantId as ClinicAutomationTenantId)
          .where("clinic_id", "=", scope.clinicId as ClinicAutomationClinicId)
          .orderBy("version", "desc").limit(1).executeTakeFirst();
        return ok(this.effective(next, automation));
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
        const decoded = this.decode(row.policy, scope, row.version);
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
