import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("clinic_automation")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("enabled", "boolean", column => column.notNull())
    .addColumn("changed_by", "text")
    .addColumn("previous_enabled", "boolean")
    .addColumn("changed_at", "timestamptz")
    .addPrimaryKeyConstraint("clinic_automation_pk", ["tenant_id", "clinic_id", "version"])
    .addCheckConstraint("clinic_automation_audit_check", sql`(
      (version = 0 and enabled = false and changed_by is null and previous_enabled is null and changed_at is null) or
      (version > 0 and changed_by is not null and length(trim(changed_by)) > 0 and previous_enabled is not null and changed_at is not null)
    )`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("clinic_automation").execute();
}
