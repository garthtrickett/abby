import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Patient corrections have independent clinic-wide settings and public audit history. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("clinic_patient_correction_settings")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("enabled", "boolean", column => column.notNull())
    .addColumn("changed_by", "text")
    .addColumn("previous_enabled", "boolean")
    .addColumn("changed_at", "timestamptz")
    .addPrimaryKeyConstraint("clinic_patient_correction_settings_pk", ["tenant_id", "clinic_id", "version"])
    .addCheckConstraint("clinic_patient_correction_settings_audit_check", sql`(
      (version = 0 and enabled = false and changed_by is null and previous_enabled is null and changed_at is null) or
      (version > 0 and changed_by is not null and length(trim(changed_by)) between 1 and 256 and
        previous_enabled is not null and changed_at is not null)
    )`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ count: string }>`select count(*)::text as count
    from clinic_patient_correction_settings where version > 0`.execute(db);
  if (rows.rows[0]?.count !== "0") throw new Error("clinic patient correction setting history must be removed before migration rollback");
  await db.schema.dropTable("clinic_patient_correction_settings").execute();
}
