import { sql } from "kysely";
import type { Kysely } from "kysely";

const scope = sql`
  tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
  clinic_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
  location_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'`;
const previousKinds = sql`kind in ('admissionDenied', 'callOwnerStarted', 'voiceFailure', 'callEnded',
  'clinikoBudgetDenied', 'clinikoBudgetUnavailable', 'clinikoProvider429', 'clinikoProviderUnavailable')`;
const currentKinds = sql`kind in ('admissionDenied', 'callOwnerStarted', 'voiceFailure', 'callEnded',
  'clinikoBudgetDenied', 'clinikoBudgetUnavailable', 'clinikoProvider429', 'clinikoProviderUnavailable',
  'intentClassificationUnavailable')`;

async function replaceCheck(db: Kysely<unknown>, table: "clinic_operational_counts" |
  "clinic_operational_daily_counts", kinds: typeof previousKinds): Promise<void> {
  const constraint = `${table}_check`;
  await db.schema.alterTable(table).dropConstraint(constraint).execute();
  await db.schema.alterTable(table).addCheckConstraint(constraint, sql`
    ${scope} and ${kinds} and count between 1 and 9007199254740991`).execute();
}

/** Adds one fixed-code aggregate; no caller, transcript, call or event timestamp is stored. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceCheck(db, "clinic_operational_counts", currentKinds);
  await replaceCheck(db, "clinic_operational_daily_counts", currentKinds);
}

/** A downgrade refuses new evidence instead of deleting it. */
export async function down(db: Kysely<unknown>): Promise<void> {
  const existing = await sql<{ present: boolean }>`select exists (
    select 1 from clinic_operational_counts where kind = 'intentClassificationUnavailable'
    union all
    select 1 from clinic_operational_daily_counts where kind = 'intentClassificationUnavailable'
  ) as present`.execute(db);
  if (existing.rows[0]?.present) throw new Error("intent classification counts prevent downgrade");
  await replaceCheck(db, "clinic_operational_counts", previousKinds);
  await replaceCheck(db, "clinic_operational_daily_counts", previousKinds);
}
