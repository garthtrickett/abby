import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import type { PatientPhoneIndexClinicId, PatientPhoneIndexNormalizedPhone, PatientPhoneIndexPatientId,
  PatientPhoneIndexTenantId } from "./generated/public/PatientPhoneIndex.ts";
import type { PatientPhoneSyncClinicId, PatientPhoneSyncTenantId } from "./generated/public/PatientPhoneSync.ts";

export type PatientPhoneLink = Readonly<{ normalizedPhone: string; patientId: string }>;
export type PatientPhoneClinicScope = Pick<LocationScope, "tenantId" | "clinicId">;
export type PhoneIndexFailure = Readonly<{ kind: "invalidInput" | "storageFailure" }>;
export type PhoneCandidates = Readonly<{
  kind: "stale" | "none" | "one" | "multiple" | "tooMany";
  patientIds: readonly string[];
  generation?: number;
}>;

const phonePattern = /^\+[1-9][0-9]{7,14}$/;
const patientIdPattern = /^[1-9][0-9]*$/;

function validScope(scope: PatientPhoneClinicScope): boolean {
  return !!scope && [scope.tenantId, scope.clinicId].every(value =>
    typeof value === "string" && value.length > 0 && value.length <= 256);
}

/** Publishes only a complete clinic snapshot; no patient record or call ID enters this store. */
export class PostgresPatientPhoneIndex {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) { this.db = db; }

  async publish(scope: PatientPhoneClinicScope, links: readonly PatientPhoneLink[]): Promise<Result<number, PhoneIndexFailure>> {
    if (!validScope(scope) || !Array.isArray(links) || links.length > 100_000 ||
        links.some(link => !link || !phonePattern.test(link.normalizedPhone) || !patientIdPattern.test(link.patientId) ||
          link.patientId.length > 20)) {
      return err({ kind: "invalidInput" });
    }
    const unique = [...new Map(links.map(link => [`${link.normalizedPhone}\0${link.patientId}`, link])).values()];
    try {
      return await this.db.transaction().execute(async trx => {
        await sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId}), hashtext(${scope.clinicId}))`.execute(trx);
        const ids = { tenant_id: scope.tenantId as PatientPhoneIndexTenantId,
          clinic_id: scope.clinicId as PatientPhoneIndexClinicId };
        const head = await trx.selectFrom("patient_phone_sync").select("generation")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneSyncTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneSyncClinicId).executeTakeFirst();
        const generation = (head?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) return err({ kind: "storageFailure" });
        await trx.deleteFrom("patient_phone_index").where("tenant_id", "=", ids.tenant_id)
          .where("clinic_id", "=", ids.clinic_id).execute();
        for (let offset = 0; offset < unique.length; offset += 500) {
          await trx.insertInto("patient_phone_index").values(unique.slice(offset, offset + 500).map(link => ({
            ...ids, normalized_phone: link.normalizedPhone as PatientPhoneIndexNormalizedPhone,
            patient_id: link.patientId as PatientPhoneIndexPatientId,
          }))).execute();
        }
        await trx.insertInto("patient_phone_sync").values({ tenant_id: scope.tenantId as PatientPhoneSyncTenantId,
          clinic_id: scope.clinicId as PatientPhoneSyncClinicId, generation, completed_at: new Date() })
          .onConflict(conflict => conflict.columns(["tenant_id", "clinic_id"])
            .doUpdateSet({ generation, completed_at: new Date() })).execute();
        return ok(generation);
      });
    } catch { return err({ kind: "storageFailure" }); }
  }

  /** Deletes all local patient links for a disconnected clinic. */
  async clear(scope: PatientPhoneClinicScope): Promise<Result<true, PhoneIndexFailure>> {
    if (!validScope(scope)) return err({ kind: "invalidInput" });
    try {
      await this.db.transaction().execute(async trx => {
        await sql`select pg_advisory_xact_lock(hashtext(${scope.tenantId}), hashtext(${scope.clinicId}))`.execute(trx);
        await trx.deleteFrom("patient_phone_index")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneIndexTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneIndexClinicId).execute();
        await trx.deleteFrom("patient_phone_sync")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneSyncTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneSyncClinicId).execute();
      });
      return ok(true);
    } catch { return err({ kind: "storageFailure" }); }
  }

  async find(scope: PatientPhoneClinicScope, normalizedPhone: string, maxAgeMs: number, now: Date = new Date()):
    Promise<Result<PhoneCandidates, PhoneIndexFailure>> {
    if (!validScope(scope) || !phonePattern.test(normalizedPhone) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
        !(now instanceof Date) || !Number.isFinite(now.getTime())) return err({ kind: "invalidInput" });
    try {
      return await this.db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
        const sync = await trx.selectFrom("patient_phone_sync").select(["generation", "completed_at"])
          .where("tenant_id", "=", scope.tenantId as PatientPhoneSyncTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneSyncClinicId).executeTakeFirst();
        if (!sync || !(sync.completed_at instanceof Date) || now.getTime() - sync.completed_at.getTime() > maxAgeMs ||
            now.getTime() < sync.completed_at.getTime() - 60_000) return ok({ kind: "stale", patientIds: [] });
        const rows = await trx.selectFrom("patient_phone_index").select("patient_id")
          .where("tenant_id", "=", scope.tenantId as PatientPhoneIndexTenantId)
          .where("clinic_id", "=", scope.clinicId as PatientPhoneIndexClinicId)
          .where("normalized_phone", "=", normalizedPhone as PatientPhoneIndexNormalizedPhone)
          .orderBy("patient_id").limit(11).execute();
        const patientIds = rows.map(row => String(row.patient_id));
        const kind = patientIds.length > 10 ? "tooMany" : patientIds.length === 0 ? "none" :
          patientIds.length === 1 ? "one" : "multiple";
        return ok({ kind, patientIds: kind === "tooMany" ? [] : patientIds, generation: sync.generation });
      });
    } catch { return err({ kind: "storageFailure" }); }
  }
}
