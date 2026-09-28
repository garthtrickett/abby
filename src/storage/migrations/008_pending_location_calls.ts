import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("pending_location_calls")
    .addColumn("call_id", "text", column => column.primaryKey())
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("status", "text", column => column.notNull())
    .addColumn("state", "jsonb", column => column.notNull())
    .addColumn("created_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addCheckConstraint("pending_location_calls_check", sql`
      status in ('pending', 'expired', 'bound')
      and jsonb_typeof(state) = 'object'
      and state->>'callId' = call_id
      and state->>'status' = status
      and state->'route'->>'tenantId' = tenant_id
      and state->'route'->>'clinicId' = clinic_id
    `)
    .execute();
  await db.schema.createIndex("pending_location_calls_scope_idx")
    .on("pending_location_calls").columns(["tenant_id", "clinic_id", "status", "call_id"]).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("pending_location_calls").execute();
}
