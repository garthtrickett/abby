import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Permanently consumed random effect IDs plus approved owner metadata only. */
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.createTable("financial_effect_barriers")
    .addColumn("tenant_id", "text", c => c.notNull())
    .addColumn("clinic_id", "text", c => c.notNull())
    .addColumn("location_id", "text", c => c.notNull())
    .addColumn("effect_ref", "uuid", c => c.notNull())
    .addColumn("owner_binding", "text", c => c.notNull())
    .addColumn("claimed_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addPrimaryKeyConstraint("financial_effect_barriers_pk", ["tenant_id", "effect_ref"])
    .addCheckConstraint("financial_effect_barriers_binding", sql`length(tenant_id) between 1 and 256 and
      length(clinic_id) between 1 and 256 and length(location_id) between 1 and 256 and
      owner_binding ~ '^[a-f0-9]{64}$' and effect_ref::text ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'`)
    .execute();
  await sql`create trigger financial_effect_barriers_portability_guard before insert or update or delete
    on financial_effect_barriers for each row execute function abby_guard_portability_write()`.execute(db);
  await sql`create trigger financial_effect_barriers_portability_truncate before truncate
    on financial_effect_barriers for each statement execute function abby_reject_portability_truncate()`.execute(db);
}
export async function down<DB>(db: Kysely<DB>): Promise<void> {
  const rows = await sql<{ occupied: boolean; frozen: boolean }>`select
    exists(select 1 from financial_effect_barriers) as occupied,
    exists(select 1 from tenant_portability_fences where frozen) as frozen`.execute(db);
  if (rows.rows[0]?.occupied !== false || rows.rows[0]?.frozen !== false) throw new Error("financial effect barriers/fences must be retained");
  await db.schema.dropTable("financial_effect_barriers").execute();
}
