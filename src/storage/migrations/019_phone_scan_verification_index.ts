import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createIndex("patient_phone_scan_links_patient_lookup_idx")
    .on("patient_phone_scan_links")
    .columns(["tenant_id", "clinic_id", "scan_ref", "patient_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("patient_phone_scan_links_patient_lookup_idx").execute();
}
