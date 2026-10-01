import { sql } from "kysely";
import type { Kysely } from "kysely";

const scope = sql`
  tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
  clinic_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
  location_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_operational_counts")
    .dropConstraint("clinic_operational_counts_check").execute();
  await db.schema.alterTable("clinic_operational_counts")
    .addCheckConstraint("clinic_operational_counts_check", sql`
      ${scope} and
      kind in ('admissionDenied', 'callOwnerStarted', 'voiceFailure', 'callEnded',
        'clinikoBudgetDenied', 'clinikoBudgetUnavailable', 'clinikoProvider429') and
      count between 1 and 9007199254740991`).execute();
}

/** Downgrade refuses existing new-kind rows instead of deleting evidence. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_operational_counts")
    .dropConstraint("clinic_operational_counts_check").execute();
  await db.schema.alterTable("clinic_operational_counts")
    .addCheckConstraint("clinic_operational_counts_check", sql`
      ${scope} and
      kind in ('admissionDenied', 'callOwnerStarted', 'voiceFailure', 'callEnded') and
      count between 1 and 9007199254740991`).execute();
}
