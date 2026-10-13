import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Durable reference/account binding; no patient, call, note or correction values. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("cliniko_contact_change_registry")
    .addColumn("tenant_id", "text", c => c.notNull())
    .addColumn("change_ref", "uuid", c => c.notNull())
    .addColumn("fingerprints", sql`text[]`, c => c.notNull())
    .addColumn("binding", "text", c => c.notNull())
    .addColumn("status", "text", c => c.notNull())
    .addColumn("created_at", "timestamptz", c => c.notNull().defaultTo(sql`now()`))
    .addColumn("completed_at", "timestamptz")
    .addColumn("completion_method", "text")
    .addColumn("completed_by", "text")
    .addPrimaryKeyConstraint("cliniko_contact_change_registry_pk", ["tenant_id", "change_ref"])
    .addCheckConstraint("cliniko_contact_change_registry_aliases", sql`cardinality(fingerprints) between 1 and 100`)
    .addCheckConstraint("cliniko_contact_change_registry_binding", sql`binding in ('reviewBound', 'legacyUnlinked')`)
    .addCheckConstraint("cliniko_contact_change_registry_state", sql`(
      (status = 'pending' and completed_at is null and completion_method is null and completed_by is null) or
      (status = 'completed' and completed_at is not null and completion_method is not null and
        ((completion_method = 'inspected' and completed_by is null) or
         (completion_method = 'staffReviewed' and completed_by is not null and length(trim(completed_by)) between 1 and 256)))
    )`)
    .execute();
  await sql`insert into cliniko_contact_change_registry (tenant_id, change_ref, fingerprints, binding, status, created_at)
    select tenant_id, change_ref, array_agg(credential_fingerprint order by credential_fingerprint),
      'legacyUnlinked', 'pending', min(created_at) from cliniko_contact_changes group by tenant_id, change_ref`.execute(db);
  await db.schema.alterTable("cliniko_contact_changes")
    .addForeignKeyConstraint("cliniko_contact_changes_registry_fk", ["tenant_id", "change_ref"],
      "cliniko_contact_change_registry", ["tenant_id", "change_ref"]).execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from cliniko_contact_change_registry`.execute(db);
  if (rows.rows[0]?.count !== "0") throw new Error("contact change reference history must be retained");
  await db.schema.alterTable("cliniko_contact_changes").dropConstraint("cliniko_contact_changes_registry_fk").execute();
  await db.schema.dropTable("cliniko_contact_change_registry").execute();
}
