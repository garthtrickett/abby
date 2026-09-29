import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("patient_phone_scan")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("scan_ref", "uuid", column => column.notNull())
    .addColumn("country_calling_code", "text", column => column.notNull())
    .addColumn("expected_generation", "integer")
    .addColumn("next_page", "integer", column => column.notNull())
    .addColumn("total_entries", "integer")
    .addColumn("seen_count", "integer", column => column.notNull())
    .addColumn("link_count", "integer", column => column.notNull())
    .addColumn("started_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addColumn("updated_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addPrimaryKeyConstraint("patient_phone_scan_pk", ["tenant_id", "clinic_id"])
    .addUniqueConstraint("patient_phone_scan_ref_unique", ["tenant_id", "clinic_id", "scan_ref"])
    .addCheckConstraint("patient_phone_scan_counts_check", sql`next_page >= 1 and seen_count >= 0 and
      link_count >= 0 and link_count <= 100000 and (total_entries is null or total_entries between 0 and 100000) and
      country_calling_code ~ '^[1-9][0-9]{0,2}$'`)
    .execute();

  await db.schema.createTable("patient_phone_scan_seen")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("scan_ref", "uuid", column => column.notNull())
    .addColumn("patient_id", "text", column => column.notNull())
    .addPrimaryKeyConstraint("patient_phone_scan_seen_pk", ["tenant_id", "clinic_id", "scan_ref", "patient_id"])
    .addForeignKeyConstraint("patient_phone_scan_seen_fk", ["tenant_id", "clinic_id", "scan_ref"],
      "patient_phone_scan", ["tenant_id", "clinic_id", "scan_ref"], constraint => constraint.onDelete("cascade"))
    .addCheckConstraint("patient_phone_scan_seen_patient_check", sql`patient_id ~ '^[1-9][0-9]*$'`)
    .execute();

  await db.schema.createTable("patient_phone_scan_links")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("scan_ref", "uuid", column => column.notNull())
    .addColumn("normalized_phone", "text", column => column.notNull())
    .addColumn("patient_id", "text", column => column.notNull())
    .addPrimaryKeyConstraint("patient_phone_scan_links_pk", ["tenant_id", "clinic_id", "scan_ref", "normalized_phone", "patient_id"])
    .addForeignKeyConstraint("patient_phone_scan_links_fk", ["tenant_id", "clinic_id", "scan_ref"],
      "patient_phone_scan", ["tenant_id", "clinic_id", "scan_ref"], constraint => constraint.onDelete("cascade"))
    .addCheckConstraint("patient_phone_scan_links_phone_check", sql`normalized_phone ~ '^\\+[1-9][0-9]{7,14}$'`)
    .addCheckConstraint("patient_phone_scan_links_patient_check", sql`patient_id ~ '^[1-9][0-9]*$'`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("patient_phone_scan_links").execute();
  await db.schema.dropTable("patient_phone_scan_seen").execute();
  await db.schema.dropTable("patient_phone_scan").execute();
}
