import { sql } from "kysely";
import type { Kysely } from "kysely";

// Disposable Phase 0 schema. Forward recovery is to migrate a fresh probe DB;
// this migration is not a production upgrade contract.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("calls")
    .addColumn("call_id", "text", column => column.primaryKey())
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("location_id", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull().defaultTo(0))
    .addColumn("policy_version", "text", column => column.notNull())
    .addColumn("state", "jsonb", column => column.notNull())
    .addColumn("created_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .execute();

  await db.schema.createTable("call_events")
    .addColumn("call_id", "text", column => column.notNull().references("calls.call_id").onDelete("cascade"))
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("sequence", "integer", column => column.notNull())
    .addColumn("kind", "text", column => column.notNull())
    .addColumn("payload", "jsonb", column => column.notNull())
    .addPrimaryKeyConstraint("call_events_pk", ["call_id", "sequence"])
    .execute();

  await db.schema.createTable("effect_outbox")
    .addColumn("effect_id", "text", column => column.primaryKey())
    .addColumn("call_id", "text", column => column.notNull().references("calls.call_id").onDelete("cascade"))
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("kind", "text", column => column.notNull())
    .addColumn("status", "text", column => column.notNull())
    .addColumn("payload", "jsonb", column => column.notNull())
    .execute();
  await db.schema.createIndex("effect_outbox_pending_idx").on("effect_outbox").columns(["status", "tenant_id"]).execute();

  await db.schema.createTable("staff_items")
    .addColumn("task_key", "text", column => column.primaryKey())
    .addColumn("call_id", "text", column => column.notNull().references("calls.call_id").onDelete("cascade"))
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("status", "text", column => column.notNull())
    .addColumn("payload", "jsonb", column => column.notNull())
    .execute();

  await db.schema.createTable("clinic_settings")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("location_id", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("policy", "jsonb", column => column.notNull())
    .addPrimaryKeyConstraint("clinic_settings_pk", ["tenant_id", "clinic_id", "location_id", "version"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("clinic_settings").execute();
  await db.schema.dropTable("staff_items").execute();
  await db.schema.dropTable("effect_outbox").execute();
  await db.schema.dropTable("call_events").execute();
  await db.schema.dropTable("calls").execute();
}
