import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Existing generations and checkpoints have no source proof, so remain stale until rebuilt. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("patient_phone_sync")
    .addColumn("credential_fingerprint", "text").execute();
  await db.schema.alterTable("patient_phone_sync")
    .addCheckConstraint("patient_phone_sync_credential_check",
      sql`credential_fingerprint is null or credential_fingerprint ~ '^[0-9a-f]{64}$'`)
    .execute();
  await db.schema.alterTable("patient_phone_scan")
    .addColumn("credential_fingerprint", "text").execute();
  await db.schema.alterTable("patient_phone_scan")
    .addCheckConstraint("patient_phone_scan_credential_check",
      sql`credential_fingerprint is null or credential_fingerprint ~ '^[0-9a-f]{64}$'`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("patient_phone_scan")
    .dropConstraint("patient_phone_scan_credential_check").execute();
  await db.schema.alterTable("patient_phone_scan").dropColumn("credential_fingerprint").execute();
  await db.schema.alterTable("patient_phone_sync")
    .dropConstraint("patient_phone_sync_credential_check").execute();
  await db.schema.alterTable("patient_phone_sync").dropColumn("credential_fingerprint").execute();
}
