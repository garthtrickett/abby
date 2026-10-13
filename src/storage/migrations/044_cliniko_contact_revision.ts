import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Account metadata only. Uncertain corrections remain fenced across process restarts. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("cliniko_contact_revisions")
    .addColumn("tenant_id", "text", c => c.notNull())
    .addColumn("credential_fingerprint", "text", c => c.notNull())
    .addColumn("version", "integer", c => c.notNull())
    .addPrimaryKeyConstraint("cliniko_contact_revisions_pk", ["tenant_id", "credential_fingerprint"])
    .addCheckConstraint("cliniko_contact_revision_version", sql`version > 0`)
    .addCheckConstraint("cliniko_contact_revision_fingerprint", sql`credential_fingerprint ~ '^[0-9a-f]{64}$'`)
    .execute();
  await db.schema.createTable("cliniko_contact_changes")
    .addColumn("tenant_id", "text", c => c.notNull())
    .addColumn("credential_fingerprint", "text", c => c.notNull())
    .addColumn("change_ref", "uuid", c => c.notNull())
    .addColumn("created_at", "timestamptz", c => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("cliniko_contact_changes_pk", ["tenant_id", "credential_fingerprint", "change_ref"])
    .addForeignKeyConstraint("cliniko_contact_changes_account_fk", ["tenant_id", "credential_fingerprint"],
      "cliniko_contact_revisions", ["tenant_id", "credential_fingerprint"])
    .execute();
  for (const table of ["patient_phone_sync", "patient_phone_scan"]) {
    await db.schema.alterTable(table).addColumn("contact_version", "integer", c => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable(table).addCheckConstraint(`${table}_contact_version`, sql`contact_version >= 0`).execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from cliniko_contact_revisions`.execute(db);
  if (rows.rows[0]?.count !== "0") throw new Error("contact revocation history must be retained");
  for (const table of ["patient_phone_scan", "patient_phone_sync"]) {
    await db.schema.alterTable(table).dropColumn("contact_version").execute();
  }
  await db.schema.dropTable("cliniko_contact_changes").execute();
  await db.schema.dropTable("cliniko_contact_revisions").execute();
}
