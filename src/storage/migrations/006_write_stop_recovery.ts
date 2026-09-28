import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table clinic_write_stop drop constraint clinic_write_stop_state_check`.execute(db);
  await sql`alter table clinic_write_stop rename column stopped_at to changed_at`.execute(db);
  await sql`alter table clinic_write_stop add column version integer not null default 0`.execute(db);
  await sql`update clinic_write_stop set version = 1 where stopped = true`.execute(db);
  await sql`alter table clinic_write_stop add constraint clinic_write_stop_state_check check (
    (version = 0 and stopped = false and actor_ref is null and reason is null and changed_at is null) or
    (version > 0 and actor_ref is not null and length(trim(actor_ref)) > 0 and reason is not null and length(trim(reason)) > 0 and changed_at is not null)
  )`.execute(db);
  await db.schema.createTable("clinic_write_stop_events")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("stopped", "boolean", column => column.notNull())
    .addColumn("actor_ref", "text", column => column.notNull())
    .addColumn("reason", "text", column => column.notNull())
    .addColumn("changed_at", "timestamptz", column => column.notNull())
    .addPrimaryKeyConstraint("clinic_write_stop_events_pk", ["tenant_id", "clinic_id", "version"])
    .addForeignKeyConstraint("clinic_write_stop_events_parent", ["tenant_id", "clinic_id"], "clinic_write_stop", ["tenant_id", "clinic_id"])
    .addCheckConstraint("clinic_write_stop_events_check", sql`version > 0 and length(trim(actor_ref)) > 0 and length(trim(reason)) > 0`)
    .execute();
  await sql`insert into clinic_write_stop_events (tenant_id, clinic_id, version, stopped, actor_ref, reason, changed_at)
    select tenant_id, clinic_id, version, stopped, actor_ref, reason, changed_at from clinic_write_stop where version = 1`.execute(db);
  await sql`alter table clinic_write_stop_inflight drop constraint clinic_write_stop_inflight_pk`.execute(db);
  await sql`alter table clinic_write_stop_inflight add column stop_version integer not null default 1`.execute(db);
  await sql`alter table clinic_write_stop_inflight add constraint clinic_write_stop_inflight_pk primary key (tenant_id, clinic_id, stop_version, effect_id)`.execute(db);
  await sql`alter table clinic_write_stop_inflight add constraint clinic_write_stop_inflight_event
    foreign key (tenant_id, clinic_id, stop_version) references clinic_write_stop_events (tenant_id, clinic_id, version)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const later = await sql<{ count: string }>`select count(*)::text as count from clinic_write_stop where version > 1`.execute(db);
  if (Number(later.rows[0]?.count ?? 0) > 0) throw new Error("write-stop recovery history cannot be represented by migration 005");
  await sql`alter table clinic_write_stop_inflight drop constraint clinic_write_stop_inflight_event`.execute(db);
  await sql`alter table clinic_write_stop_inflight drop constraint clinic_write_stop_inflight_pk`.execute(db);
  await sql`alter table clinic_write_stop_inflight drop column stop_version`.execute(db);
  await sql`alter table clinic_write_stop_inflight add constraint clinic_write_stop_inflight_pk primary key (tenant_id, clinic_id, effect_id)`.execute(db);
  await db.schema.dropTable("clinic_write_stop_events").execute();
  await sql`alter table clinic_write_stop drop constraint clinic_write_stop_state_check`.execute(db);
  await sql`alter table clinic_write_stop drop column version`.execute(db);
  await sql`alter table clinic_write_stop rename column changed_at to stopped_at`.execute(db);
  await sql`alter table clinic_write_stop add constraint clinic_write_stop_state_check check (
    (stopped = false and actor_ref is null and reason is null and stopped_at is null) or
    (stopped = true and actor_ref is not null and length(trim(actor_ref)) > 0 and reason is not null and length(trim(reason)) > 0 and stopped_at is not null)
  )`.execute(db);
}
