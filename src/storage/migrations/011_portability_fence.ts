import { sql } from "kysely";
import type { Kysely } from "kysely";

const guardedTables = ["calls", "call_events", "effect_outbox", "staff_items", "clinic_settings", "clinic_automation",
  "clinic_write_stop", "clinic_write_stop_inflight", "clinic_write_stop_events", "clinic_knowledge_heads",
  "clinic_knowledge_events", "pending_location_calls", "effect_call_leases"] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("tenant_portability_fences")
    .addColumn("tenant_id", "text", column => column.primaryKey())
    .addColumn("version", "integer", column => column.notNull().defaultTo(0))
    .addColumn("frozen", "boolean", column => column.notNull().defaultTo(false))
    .addColumn("last_request_ref", "text")
    .addColumn("changed_at", "timestamptz")
    .addCheckConstraint("tenant_portability_fences_check", sql`length(tenant_id) between 1 and 256 and version >= 0 and
      (last_request_ref is null or length(last_request_ref) between 1 and 256)`)
    .execute();
  await db.schema.createTable("tenant_portability_fence_events")
    .addColumn("tenant_id", "text", column => column.notNull().references("tenant_portability_fences.tenant_id"))
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("kind", "text", column => column.notNull())
    .addColumn("request_ref", "text", column => column.notNull())
    .addColumn("actor_ref", "text", column => column.notNull())
    .addColumn("reason", "text", column => column.notNull())
    .addColumn("changed_at", "timestamptz", column => column.notNull())
    .addPrimaryKeyConstraint("tenant_portability_fence_events_pk", ["tenant_id", "version"])
    .addUniqueConstraint("tenant_portability_fence_events_request_unique", ["tenant_id", "request_ref"])
    .addCheckConstraint("tenant_portability_fence_events_check", sql`version > 0 and kind in ('freeze', 'release') and
      length(request_ref) between 1 and 256 and length(actor_ref) between 1 and 256 and length(reason) between 1 and 1000`)
    .execute();

  // Shared locks let ordinary writes proceed in parallel; an exclusive freeze waits for every earlier write.
  await sql`create function abby_assert_portability_writable(p_tenant text) returns void language plpgsql
    security definer set search_path = pg_catalog, public as $$
    declare is_frozen boolean;
    begin
      if p_tenant is null or length(p_tenant) < 1 or length(p_tenant) > 256 then
        raise exception 'invalid portability tenant' using errcode = 'P0001';
      end if;
      perform pg_advisory_xact_lock_shared(172934501, hashtext(p_tenant));
      insert into tenant_portability_fences (tenant_id) values (p_tenant) on conflict do nothing;
      select frozen into is_frozen from tenant_portability_fences where tenant_id = p_tenant for share;
      -- A repeatable-read writer with a snapshot older than a newly inserted fence must fail closed.
      if not found or is_frozen then
        raise exception 'tenant portability fence active' using errcode = 'P0001';
      end if;
    end
  $$`.execute(db);
  await sql`create function abby_guard_portability_write() returns trigger language plpgsql as $$
    declare owner_tenant text;
    begin
      if tg_table_name = 'effect_call_leases' then
        if tg_op = 'UPDATE' and old.call_id is distinct from new.call_id then
          raise exception 'effect lease call cannot change' using errcode = 'P0001';
        end if;
        select tenant_id into owner_tenant from calls where call_id =
          case when tg_op = 'DELETE' then old.call_id else new.call_id end;
        -- The parent calls DELETE was already guarded before its FK cascade deletes a lease.
        if not found and tg_op = 'DELETE' then return old; end if;
        if not found then raise exception 'effect lease call missing' using errcode = 'P0001'; end if;
      else
        if tg_op = 'UPDATE' and old.tenant_id is distinct from new.tenant_id then
          raise exception 'tenant ownership cannot change' using errcode = 'P0001';
        end if;
        owner_tenant := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
      end if;
      perform abby_assert_portability_writable(owner_tenant);
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end
  $$`.execute(db);
  await sql`create function abby_reject_portability_truncate() returns trigger language plpgsql as $$
    begin
      raise exception 'truncate bypasses tenant portability fences' using errcode = 'P0001';
    end
  $$`.execute(db);
  for (const table of guardedTables) {
    await sql.raw(`create trigger ${table}_portability_guard before insert or update or delete on ${table}
      for each row execute function abby_guard_portability_write()`).execute(db);
    await sql.raw(`create trigger ${table}_portability_truncate before truncate on ${table}
      for each statement execute function abby_reject_portability_truncate()`).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of guardedTables) {
    await sql.raw(`drop trigger ${table}_portability_guard on ${table}`).execute(db);
    await sql.raw(`drop trigger ${table}_portability_truncate on ${table}`).execute(db);
  }
  await sql`drop function abby_reject_portability_truncate()`.execute(db);
  await sql`drop function abby_guard_portability_write()`.execute(db);
  await sql`drop function abby_assert_portability_writable(text)`.execute(db);
  await db.schema.dropTable("tenant_portability_fence_events").execute();
  await db.schema.dropTable("tenant_portability_fences").execute();
}
