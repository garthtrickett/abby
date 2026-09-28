import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("clinic_knowledge_heads")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("location_id", "text", column => column.notNull())
    .addColumn("source_ref", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull().defaultTo(0))
    .addColumn("effective_version", "integer")
    .addPrimaryKeyConstraint("clinic_knowledge_heads_pk", ["tenant_id", "clinic_id", "location_id", "source_ref"])
    .addCheckConstraint("clinic_knowledge_heads_check", sql`version >= 0 and (effective_version is null or (effective_version > 0 and effective_version <= version)) and length(trim(source_ref)) between 1 and 256`)
    .execute();
  await db.schema.createTable("clinic_knowledge_events")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("location_id", "text", column => column.notNull())
    .addColumn("source_ref", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("status", "text", column => column.notNull())
    .addColumn("owner_ref", "text", column => column.notNull())
    .addColumn("answer_text", "text", column => column.notNull())
    .addColumn("effective_from", "timestamptz", column => column.notNull())
    .addColumn("effective_until", "timestamptz", column => column.notNull())
    .addColumn("actor_ref", "text", column => column.notNull())
    .addColumn("changed_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addPrimaryKeyConstraint("clinic_knowledge_events_pk", ["tenant_id", "clinic_id", "location_id", "source_ref", "version"])
    .addForeignKeyConstraint("clinic_knowledge_events_head", ["tenant_id", "clinic_id", "location_id", "source_ref"],
      "clinic_knowledge_heads", ["tenant_id", "clinic_id", "location_id", "source_ref"])
    .addCheckConstraint("clinic_knowledge_events_check", sql`version > 0 and status in ('draft', 'approved', 'revoked') and
      length(trim(owner_ref)) between 1 and 256 and length(trim(actor_ref)) between 1 and 256 and
      length(trim(answer_text)) > 0 and length(answer_text) <= 2000 and effective_from < effective_until`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("clinic_knowledge_events").execute();
  await db.schema.dropTable("clinic_knowledge_heads").execute();
}
