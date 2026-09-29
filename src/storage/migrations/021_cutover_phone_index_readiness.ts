import { sql } from "kysely";
import type { Kysely } from "kysely";

/** New cutovers record the target clinic's approved phone-index freshness plan.
 * Existing rows remain without a plan and cannot publish until administratively resolved.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("number_cutovers")
    .addColumn("phone_index_country_calling_code", "text")
    .addColumn("phone_index_max_age_ms", "integer")
    .execute();
  await db.schema.alterTable("number_cutovers")
    .addCheckConstraint("number_cutovers_phone_index_plan_check", sql`(
      (phone_index_country_calling_code is null and phone_index_max_age_ms is null) or
      (phone_index_country_calling_code ~ '^[1-9][0-9]{0,2}$' and
        phone_index_max_age_ms between 1 and 3600000)
    )`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("number_cutovers").dropConstraint("number_cutovers_phone_index_plan_check").execute();
  await db.schema.alterTable("number_cutovers")
    .dropColumn("phone_index_max_age_ms")
    .dropColumn("phone_index_country_calling_code")
    .execute();
}
