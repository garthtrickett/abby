import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("patient_phone_clinic_status")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("enabled", "boolean", column => column.notNull())
    .addColumn("changed_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addPrimaryKeyConstraint("patient_phone_clinic_status_pk", ["tenant_id", "clinic_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("patient_phone_clinic_status").execute();
}
