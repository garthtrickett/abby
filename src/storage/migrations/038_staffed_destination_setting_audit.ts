import { sql } from "kysely";
import type { Kysely } from "kysely";

// Preserve the existing change-kind contract, including the legacy booking baseline.
const previousCheck = sql`(
  (setting_kind = 'booking' and previous_after_hours_mode is null and previous_cancellation_enabled is null and previous_rescheduling_enabled is null) or
  (setting_kind = 'afterHours' and previous_booking_enabled is null and previous_cancellation_enabled is null and previous_rescheduling_enabled is null and
    previous_after_hours_mode in ('staffRequest', 'approvedInfoAndRequest') and changed_by is not null and changed_at is not null) or
  (setting_kind in ('urgent', 'staffSchedule', 'greeting') and previous_booking_enabled is null and
    previous_after_hours_mode is null and previous_cancellation_enabled is null and previous_rescheduling_enabled is null and changed_by is not null and changed_at is not null) or
  (setting_kind = 'cancellation' and previous_rescheduling_enabled is null and previous_booking_enabled is null and previous_after_hours_mode is null and
    previous_cancellation_enabled is not null and changed_by is not null and changed_at is not null and
    policy ? 'cancellationEnabled' and jsonb_typeof(policy->'cancellationEnabled') = 'boolean') or
  (setting_kind = 'rescheduling' and previous_booking_enabled is null and previous_after_hours_mode is null and previous_cancellation_enabled is null and
    previous_rescheduling_enabled is not null and changed_by is not null and changed_at is not null and
    policy ? 'reschedulingEnabled' and jsonb_typeof(policy->'reschedulingEnabled') = 'boolean')
)`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_settings").addColumn("previous_staffed_destination_ref", "text").execute();
  await db.schema.alterTable("clinic_settings").dropConstraint("clinic_settings_change_kind_check").execute();
  await sql`alter table clinic_settings add constraint clinic_settings_change_kind_check check (
    (previous_staffed_destination_ref is null and ${previousCheck}) or
    (setting_kind = 'staffedDestination' and previous_booking_enabled is null and previous_after_hours_mode is null and
      previous_cancellation_enabled is null and previous_rescheduling_enabled is null and changed_by is not null and changed_at is not null and
      (previous_staffed_destination_ref is null or (length(btrim(previous_staffed_destination_ref)) > 0 and length(previous_staffed_destination_ref) <= 256)) and
      (not (policy ? 'transferDestinationRef') or
        (jsonb_typeof(policy->'transferDestinationRef') = 'string' and length(btrim(policy->>'transferDestinationRef')) > 0 and length(policy->>'transferDestinationRef') <= 256)))
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from clinic_settings where setting_kind = 'staffedDestination'`.execute(db);
  if (rows.rows[0]?.count !== "0") throw new Error("staffed destination setting history must be removed before migration rollback");
  await db.schema.alterTable("clinic_settings").dropConstraint("clinic_settings_change_kind_check").execute();
  await db.schema.alterTable("clinic_settings").dropColumn("previous_staffed_destination_ref").execute();
  await sql`alter table clinic_settings add constraint clinic_settings_change_kind_check check (${previousCheck})`.execute(db);
}
