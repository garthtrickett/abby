import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Clinic aggregate abuse control only. No patient/address/call key or challenge record. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("patient_verification_budgets")
    .addColumn("tenant_id", "text", c => c.notNull())
    .addColumn("clinic_id", "text", c => c.notNull())
    .addColumn("kind", "text", c => c.notNull())
    .addColumn("window_started_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addColumn("attempts", "integer", c => c.notNull().defaultTo(0))
    .addPrimaryKeyConstraint("patient_verification_budgets_pkey", ["tenant_id", "clinic_id", "kind"])
    .addCheckConstraint("patient_verification_budgets_kind_check", sql`kind in ('issue', 'answer')`)
    .addCheckConstraint("patient_verification_budgets_attempts_check", sql`attempts >= 0 and attempts <= case when kind = 'issue' then 30 else 90 end`)
    .execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("patient_verification_budgets").execute();
}
