import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Historic approvals need reapproval: their business time zone was never recorded. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("cliniko_catalogue_approvals")
    .addColumn("business_time_zone", "text").execute();
  await sql`alter table cliniko_catalogue_approvals add constraint cliniko_approval_business_time_zone_check
    check (business_time_zone is null or (approved and length(business_time_zone) between 1 and 128))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cliniko_catalogue_approvals
    drop constraint cliniko_approval_business_time_zone_check`.execute(db);
  await db.schema.alterTable("cliniko_catalogue_approvals")
    .dropColumn("business_time_zone").execute();
}
