import { sql } from "kysely";
import type { Kysely } from "kysely";

/** The key is a SHA-256 digest of the configured API credential, never the credential itself. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("cliniko_request_budgets")
    .addColumn("budget_ref", "text", column => column.primaryKey())
    .addColumn("sent_at_ms", "jsonb", column => column.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("cooldown_until_ms", "bigint", column => column.notNull().defaultTo(0))
    .addColumn("max_per_minute", "integer", column => column.notNull())
    .addCheckConstraint("cliniko_request_budgets_check", sql`budget_ref ~ '^[0-9a-f]{64}$' and
      jsonb_typeof(sent_at_ms) = 'array' and cooldown_until_ms >= 0 and
      max_per_minute between 1 and 200`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("cliniko_request_budgets").execute();
}
