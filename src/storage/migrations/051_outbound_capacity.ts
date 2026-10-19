import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Independently random allocations, stable approved campaign owner hash and
 * operational timestamps only. No call/recipient/provider/request identifiers. */
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.createTable("outbound_capacity_allocations")
    .addColumn("tenant_id", "text", c => c.notNull())
    .addColumn("clinic_id", "text", c => c.notNull())
    .addColumn("location_id", "text", c => c.notNull())
    .addColumn("allocation_ref", "uuid", c => c.notNull())
    .addColumn("owner_binding", "text", c => c.notNull())
    .addColumn("acquired_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addColumn("released_at", "timestamptz")
    .addPrimaryKeyConstraint("outbound_capacity_allocations_pk", ["tenant_id", "allocation_ref"])
    .addCheckConstraint("outbound_capacity_allocations_binding", sql`length(tenant_id) between 1 and 256 and
      length(clinic_id) between 1 and 256 and length(location_id) between 1 and 256 and owner_binding ~ '^[a-f0-9]{64}$'
      and allocation_ref::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      and (released_at is null or released_at >= acquired_at)`).execute();
  await db.schema.createIndex("outbound_capacity_held").on("outbound_capacity_allocations").columns(["tenant_id", "owner_binding"]).where("released_at", "is", null).execute();
  await sql`create trigger outbound_capacity_portability_guard before insert or update or delete
    on outbound_capacity_allocations for each row execute function abby_guard_portability_write()`.execute(db);
  await sql`create trigger outbound_capacity_portability_truncate before truncate
    on outbound_capacity_allocations for each statement execute function abby_reject_portability_truncate()`.execute(db);
}
export async function down<DB>(db: Kysely<DB>): Promise<void> {
  const rows = await sql<{ occupied: boolean }>`select exists(select 1 from outbound_capacity_allocations) or
    exists(select 1 from tenant_portability_fences where frozen) or exists(select 1 from tenant_config_imports
      where jsonb_path_exists(source_history, '$.locations[*].outboundCapacity[*]')) as occupied`.execute(db);
  if (rows.rows[0]?.occupied !== false) throw new Error("outbound capacity history/fences must be retained");
  await db.schema.dropTable("outbound_capacity_allocations").execute();
}
