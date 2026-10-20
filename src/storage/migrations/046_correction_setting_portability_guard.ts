import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Bind the existing correction history to the established tenant freeze/write-lock contract. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create trigger clinic_patient_correction_settings_portability_guard
    before insert or update or delete on clinic_patient_correction_settings
    for each row execute function abby_guard_portability_write()`.execute(db);
  await sql`create trigger clinic_patient_correction_settings_portability_truncate
    before truncate on clinic_patient_correction_settings
    for each statement execute function abby_reject_portability_truncate()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const frozen = await sql<{ frozen: boolean }>`select exists(select 1 from tenant_portability_fences where frozen) as frozen`.execute(db);
  if (frozen.rows[0]?.frozen !== false) throw new Error("cannot remove correction portability guards while a tenant is frozen");
  await sql`drop trigger clinic_patient_correction_settings_portability_truncate on clinic_patient_correction_settings`.execute(db);
  await sql`drop trigger clinic_patient_correction_settings_portability_guard on clinic_patient_correction_settings`.execute(db);
}
