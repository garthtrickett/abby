import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("patient_phone_sync")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("generation", "integer", column => column.notNull())
    .addColumn("completed_at", "timestamptz", column => column.notNull())
    .addPrimaryKeyConstraint("patient_phone_sync_pk", ["tenant_id", "clinic_id"])
    .addCheckConstraint("patient_phone_sync_generation_check", sql`generation > 0`)
    .execute();

  await db.schema.createTable("patient_phone_index")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("normalized_phone", "text", column => column.notNull())
    .addColumn("patient_id", "text", column => column.notNull())
    .addPrimaryKeyConstraint("patient_phone_index_pk", ["tenant_id", "clinic_id", "normalized_phone", "patient_id"])
    .addCheckConstraint("patient_phone_index_phone_check", sql`left(normalized_phone, 1) = '+' and substring(normalized_phone from 2) ~ '^[1-9][0-9]{7,14}$'`)
    .addCheckConstraint("patient_phone_index_patient_check", sql`patient_id ~ '^[1-9][0-9]*$'`)
    .execute();
  await db.schema.createIndex("patient_phone_index_patient_idx").on("patient_phone_index")
    .columns(["tenant_id", "clinic_id", "patient_id"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("patient_phone_index").execute();
  await db.schema.dropTable("patient_phone_sync").execute();
}
