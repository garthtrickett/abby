import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("clinic_write_stop")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("stopped", "boolean", column => column.notNull())
    .addColumn("actor_ref", "text")
    .addColumn("reason", "text")
    .addColumn("stopped_at", "timestamptz")
    .addPrimaryKeyConstraint("clinic_write_stop_pk", ["tenant_id", "clinic_id"])
    .addCheckConstraint("clinic_write_stop_state_check", sql`(
      (stopped = false and actor_ref is null and reason is null and stopped_at is null) or
      (stopped = true and actor_ref is not null and length(trim(actor_ref)) > 0 and reason is not null and length(trim(reason)) > 0 and stopped_at is not null)
    )`)
    .execute();
  await db.schema.createTable("clinic_write_stop_inflight")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("effect_id", "text", column => column.notNull())
    .addColumn("call_id", "text", column => column.notNull())
    .addColumn("action_key", "text", column => column.notNull())
    .addColumn("status", "text", column => column.notNull())
    .addPrimaryKeyConstraint("clinic_write_stop_inflight_pk", ["tenant_id", "clinic_id", "effect_id"])
    .addForeignKeyConstraint("clinic_write_stop_inflight_parent", ["tenant_id", "clinic_id"], "clinic_write_stop", ["tenant_id", "clinic_id"])
    .addCheckConstraint("clinic_write_stop_inflight_status_check", sql`status in ('possiblySent', 'uncertain')`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("clinic_write_stop_inflight").execute();
  await db.schema.dropTable("clinic_write_stop").execute();
}
