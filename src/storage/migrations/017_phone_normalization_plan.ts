import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("patient_phone_sync")
    .addColumn("country_calling_code", "text")
    .addColumn("normalization_version", "integer")
    .execute();
  await db.schema.alterTable("patient_phone_sync")
    .addCheckConstraint("patient_phone_sync_plan_check", sql`(
      country_calling_code is null and normalization_version is null
    ) or (
      country_calling_code ~ '^[1-9][0-9]{0,2}$' and normalization_version > 0
    )`)
    .execute();
  await db.schema.alterTable("patient_phone_scan")
    .addColumn("normalization_version", "integer")
    .execute();
  await db.schema.alterTable("patient_phone_scan")
    .addCheckConstraint("patient_phone_scan_plan_check", sql`normalization_version is null or normalization_version > 0`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("patient_phone_scan").dropConstraint("patient_phone_scan_plan_check").execute();
  await db.schema.alterTable("patient_phone_scan").dropColumn("normalization_version").execute();
  await db.schema.alterTable("patient_phone_sync").dropConstraint("patient_phone_sync_plan_check").execute();
  await db.schema.alterTable("patient_phone_sync").dropColumn("normalization_version").dropColumn("country_calling_code").execute();
}
