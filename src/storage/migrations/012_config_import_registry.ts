import { sql } from "kysely";
import type { Kysely } from "kysely";

// The buyer owns this receipt and the complete source history. Native target rows
// are inserted in the same transaction; a crash can leave neither or both.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("tenant_config_imports")
    .addColumn("target_tenant_id", "text", column => column.primaryKey())
    .addColumn("archive_id", "text", column => column.notNull())
    .addColumn("manifest_digest", "text", column => column.notNull())
    .addColumn("receipt", "jsonb", column => column.notNull())
    .addColumn("source_history", "jsonb", column => column.notNull())
    .addColumn("staged_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addCheckConstraint("tenant_config_imports_check", sql`length(target_tenant_id) between 1 and 256 and
      length(archive_id) between 1 and 256 and manifest_digest ~ '^[0-9a-f]{64}$'`)
    .execute();
  await sql`create function abby_guard_config_import_write() returns trigger language plpgsql as $$
    begin
      if tg_op = 'UPDATE' and old.target_tenant_id is distinct from new.target_tenant_id then
        raise exception 'tenant ownership cannot change' using errcode = 'P0001';
      end if;
      perform abby_assert_portability_writable(
        case when tg_op = 'DELETE' then old.target_tenant_id else new.target_tenant_id end);
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end
  $$`.execute(db);
  await sql`create trigger tenant_config_imports_portability_guard before insert or update or delete
    on tenant_config_imports for each row execute function abby_guard_config_import_write()`.execute(db);
  await sql`create trigger tenant_config_imports_portability_truncate before truncate on tenant_config_imports
    for each statement execute function abby_reject_portability_truncate()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger tenant_config_imports_portability_truncate on tenant_config_imports`.execute(db);
  await sql`drop trigger tenant_config_imports_portability_guard on tenant_config_imports`.execute(db);
  await sql`drop function abby_guard_config_import_write()`.execute(db);
  await db.schema.dropTable("tenant_config_imports").execute();
}
