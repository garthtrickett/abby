import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { PolicyFailure } from "../core/host.ts";
import { validPatientCorrectionAuditCursor, validPatientCorrectionClinicScope, validPatientCorrectionSettingChange } from "../core/clinic-patient-correction-setting.ts";
import type { ClinicPatientCorrectionAuditEntry, ClinicPatientCorrectionAuditPage, ClinicPatientCorrectionSettingStore,
  ClinicPatientCorrectionState, PatientCorrectionClinicScope } from "../core/clinic-patient-correction-setting.ts";
import type Database from "./generated/Database.ts";
import type { ClinicPatientCorrectionSettingsClinicId, ClinicPatientCorrectionSettingsTenantId,
  ClinicPatientCorrectionSettingsVersion } from "./generated/public/ClinicPatientCorrectionSettings.ts";

function ids(scope: PatientCorrectionClinicScope) {
  return { tenant_id: scope.tenantId as ClinicPatientCorrectionSettingsTenantId,
    clinic_id: scope.clinicId as ClinicPatientCorrectionSettingsClinicId };
}

export class PostgresClinicPatientCorrectionSettingStore implements ClinicPatientCorrectionSettingStore {
  private readonly db: Kysely<Database>;
  constructor(db: Kysely<Database>) { this.db = db; }

  async read(scope: PatientCorrectionClinicScope): Promise<Result<ClinicPatientCorrectionState, PolicyFailure>> {
    if (!validPatientCorrectionClinicScope(scope)) return err({ kind: "invalidValue" });
    try {
      const key = ids(scope);
      const row = await this.db.selectFrom("clinic_patient_correction_settings").select(["version", "enabled"])
        .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
        .orderBy("version", "desc").limit(1).executeTakeFirst();
      return ok(row ? { version: String(row.version), enabled: row.enabled } : { version: "0", enabled: false });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async changeEnabled(scope: PatientCorrectionClinicScope, expectedVersion: string, enabled: boolean,
                      actorRef: string): Promise<Result<ClinicPatientCorrectionState, PolicyFailure>> {
    if (!validPatientCorrectionSettingChange(scope, expectedVersion, enabled, actorRef)) return err({ kind: "invalidValue" });
    try {
      return await this.db.transaction().execute(async trx => {
        const key = ids(scope);
        await trx.insertInto("clinic_patient_correction_settings").values({ ...key, version: 0 as ClinicPatientCorrectionSettingsVersion, enabled: false })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id", "version"]).doNothing()).execute();
        await trx.selectFrom("clinic_patient_correction_settings").select("version")
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
          .where("version", "=", 0 as ClinicPatientCorrectionSettingsVersion).forUpdate().executeTakeFirstOrThrow();
        const previous = await trx.selectFrom("clinic_patient_correction_settings").select(["version", "enabled"])
          .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
          .orderBy("version", "desc").limit(1).executeTakeFirstOrThrow();
        if (String(previous.version) !== expectedVersion) return err({ kind: "versionConflict" });
        const version = previous.version + 1;
        await trx.insertInto("clinic_patient_correction_settings").values({ ...key, version: version as ClinicPatientCorrectionSettingsVersion,
          enabled, previous_enabled: previous.enabled, changed_by: actorRef, changed_at: sql`clock_timestamp()` }).execute();
        return ok({ version: String(version), enabled });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  async listChanges(scope: PatientCorrectionClinicScope, afterVersion?: number): Promise<Result<ClinicPatientCorrectionAuditPage, PolicyFailure>> {
    if (!validPatientCorrectionClinicScope(scope) || !validPatientCorrectionAuditCursor(afterVersion)) return err({ kind: "invalidValue" });
    try {
      const key = ids(scope);
      const rows = await this.db.selectFrom("clinic_patient_correction_settings")
        .select(["version", "enabled", "previous_enabled", "changed_by", "changed_at"])
        .where("tenant_id", "=", key.tenant_id).where("clinic_id", "=", key.clinic_id)
        .where("version", ">", (afterVersion ?? 0) as ClinicPatientCorrectionSettingsVersion)
        .orderBy("version", "asc").limit(50).execute();
      const entries: ClinicPatientCorrectionAuditEntry[] = [];
      for (const row of rows) {
        if (typeof row.previous_enabled !== "boolean" || typeof row.changed_by !== "string" ||
            !row.changed_by.trim() || row.changed_by.length > 256 || !(row.changed_at instanceof Date) ||
            !Number.isFinite(row.changed_at.getTime())) return err({ kind: "storageFailure" });
        entries.push({ version: String(row.version), enabled: row.enabled, previousEnabled: row.previous_enabled,
          actorRef: row.changed_by, changedAt: row.changed_at.toISOString() });
      }
      return ok({ entries, ...(entries.length === 50 ? { nextAfterVersion: Number(entries[49]!.version) } : {}) });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
