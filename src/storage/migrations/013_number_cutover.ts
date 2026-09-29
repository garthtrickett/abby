import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Synthetic host-owned number directory and audited configuration-only switch.
 * Down is for disposable rehearsal databases. A deployed host must preserve
 * route/event history and use forward recovery, never drop live route tables.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("number_routes")
    .addColumn("account_ref", "text", column => column.notNull())
    .addColumn("dialed_number", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull().defaultTo(1))
    .addColumn("assignment", "jsonb", column => column.notNull())
    .addPrimaryKeyConstraint("number_routes_pk", ["account_ref", "dialed_number"])
    .addCheckConstraint("number_routes_check", sql`length(account_ref) between 1 and 256 and
      length(dialed_number) between 1 and 256 and version > 0 and jsonb_typeof(assignment) = 'object'`)
    .execute();
  await db.schema.createTable("number_cutovers")
    .addColumn("account_ref", "text", column => column.notNull())
    .addColumn("dialed_number", "text", column => column.notNull())
    .addColumn("source_tenant_id", "text", column => column.notNull())
    .addColumn("target_tenant_id", "text", column => column.notNull())
    .addColumn("source_fence_version", "integer", column => column.notNull())
    .addColumn("archive_id", "text", column => column.notNull())
    .addColumn("manifest_digest", "text", column => column.notNull())
    .addColumn("source_schema_version", "text", column => column.notNull())
    .addColumn("source_assignment", "jsonb", column => column.notNull())
    .addColumn("target_assignment", "jsonb", column => column.notNull())
    .addColumn("staged_route_version", "integer", column => column.notNull())
    .addColumn("published_route_version", "integer")
    .addColumn("state", "text", column => column.notNull())
    .addColumn("updated_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addPrimaryKeyConstraint("number_cutovers_pk", ["account_ref", "dialed_number"])
    .addForeignKeyConstraint("number_cutovers_route_fk", ["account_ref", "dialed_number"],
      "number_routes", ["account_ref", "dialed_number"])
    .addCheckConstraint("number_cutovers_check", sql`length(source_tenant_id) between 1 and 256 and
      length(target_tenant_id) between 1 and 256 and source_tenant_id <> target_tenant_id and
      source_fence_version > 0 and staged_route_version > 0 and
      length(archive_id) between 1 and 256 and manifest_digest ~ '^[0-9a-f]{64}$' and
      length(source_schema_version) between 1 and 256 and
      jsonb_typeof(source_assignment) = 'object' and jsonb_typeof(target_assignment) = 'object' and
      state in ('staged', 'published', 'rollbackPendingRelease', 'rolledBack') and
      ((state = 'staged' and published_route_version is null) or
       (state <> 'staged' and (published_route_version is null or published_route_version > staged_route_version)))`)
    .execute();
  await db.schema.createIndex("number_cutovers_source_state_idx").on("number_cutovers")
    .columns(["source_tenant_id", "state"]).execute();
  await db.schema.createTable("number_route_events")
    .addColumn("event_id", "bigserial", column => column.primaryKey())
    .addColumn("account_ref", "text", column => column.notNull())
    .addColumn("dialed_number", "text", column => column.notNull())
    .addColumn("kind", "text", column => column.notNull())
    .addColumn("route_version", "integer", column => column.notNull())
    .addColumn("actor_ref", "text", column => column.notNull())
    .addColumn("audit_ref", "text", column => column.notNull())
    .addColumn("changed_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addForeignKeyConstraint("number_route_events_route_fk", ["account_ref", "dialed_number"],
      "number_routes", ["account_ref", "dialed_number"])
    .addUniqueConstraint("number_route_events_audit_unique", ["account_ref", "dialed_number", "audit_ref"])
    .addCheckConstraint("number_route_events_check", sql`kind in ('stage', 'publish', 'discard', 'beginRollback', 'finishRollback') and
      route_version > 0 and length(actor_ref) between 1 and 256 and length(audit_ref) between 1 and 256`)
    .execute();

  // A direct SQL release cannot bypass an active published route.
  await sql`create function abby_guard_number_cutover_release() returns trigger language plpgsql as $$
    begin
      if old.frozen and not new.frozen and exists (
        select 1 from number_cutovers where source_tenant_id = old.tenant_id and state = 'published'
      ) then
        raise exception 'published route still owns source fence' using errcode = 'P0001';
      end if;
      return new;
    end
  $$`.execute(db);
  await sql`create trigger tenant_portability_fence_route_release_guard before update of frozen
    on tenant_portability_fences for each row execute function abby_guard_number_cutover_release()`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop trigger tenant_portability_fence_route_release_guard on tenant_portability_fences`.execute(db);
  await sql`drop function abby_guard_number_cutover_release()`.execute(db);
  await db.schema.dropTable("number_route_events").execute();
  await db.schema.dropTable("number_cutovers").execute();
  await db.schema.dropTable("number_routes").execute();
}
