import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Fixed-code UTC daily aggregates. No call, phone, patient, text or event timestamp. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("clinic_operational_daily_counts")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("location_id", "text", column => column.notNull())
    .addColumn("date", "date", column => column.notNull())
    .addColumn("kind", "text", column => column.notNull())
    .addColumn("count", "bigint", column => column.notNull())
    .addPrimaryKeyConstraint("clinic_operational_daily_counts_pk",
      ["tenant_id", "clinic_id", "location_id", "date", "kind"])
    .addCheckConstraint("clinic_operational_daily_counts_check", sql`
      tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
      clinic_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
      location_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
      kind in ('admissionDenied', 'callOwnerStarted', 'voiceFailure', 'callEnded',
        'clinikoBudgetDenied', 'clinikoBudgetUnavailable', 'clinikoProvider429',
        'clinikoProviderUnavailable') and
      count between 1 and 9007199254740991`)
    .execute();
  await db.schema.createIndex("clinic_operational_daily_counts_date_idx")
    .on("clinic_operational_daily_counts").column("date").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("clinic_operational_daily_counts").execute();
}
