import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("effect_call_leases")
    .addColumn("call_id", "text", column => column.primaryKey().references("calls.call_id").onDelete("cascade"))
    .addColumn("owner_token", "text", column => column.notNull())
    .addColumn("expires_at", "timestamptz", column => column.notNull())
    .addCheckConstraint("effect_call_leases_owner_check", sql`length(owner_token) between 1 and 256`)
    .execute();
  await db.schema.createIndex("effect_call_leases_expiry_idx").on("effect_call_leases").column("expires_at").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("effect_call_leases").execute();
}
