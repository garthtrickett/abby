import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Rescheduling keeps its own previous value under the shared location policy lock. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_settings").addColumn("previous_rescheduling_enabled", "boolean").execute();
  await db.schema.alterTable("clinic_settings").dropConstraint("clinic_settings_change_kind_check").execute();
  await sql`alter table clinic_settings add constraint clinic_settings_change_kind_check check (
    (setting_kind = 'booking' and previous_after_hours_mode is null and previous_cancellation_enabled is null and previous_rescheduling_enabled is null) or
    (setting_kind = 'afterHours' and previous_booking_enabled is null and previous_cancellation_enabled is null and previous_rescheduling_enabled is null and
      previous_after_hours_mode in ('staffRequest', 'approvedInfoAndRequest') and
      changed_by is not null and changed_at is not null) or
    (setting_kind in ('urgent', 'staffSchedule', 'greeting') and previous_booking_enabled is null and
      previous_after_hours_mode is null and previous_cancellation_enabled is null and previous_rescheduling_enabled is null and
      changed_by is not null and changed_at is not null) or
    (setting_kind = 'cancellation' and previous_rescheduling_enabled is null and previous_booking_enabled is null and previous_after_hours_mode is null and
      previous_cancellation_enabled is not null and changed_by is not null and changed_at is not null and
      policy ? 'cancellationEnabled' and jsonb_typeof(policy->'cancellationEnabled') = 'boolean') or
    (setting_kind = 'rescheduling' and previous_booking_enabled is null and previous_after_hours_mode is null and
      previous_cancellation_enabled is null and previous_rescheduling_enabled is not null and
      changed_by is not null and changed_at is not null and
      policy ? 'reschedulingEnabled' and jsonb_typeof(policy->'reschedulingEnabled') = 'boolean')
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from clinic_settings where setting_kind = 'rescheduling'`.execute(db);
  if (rows.rows[0]?.count !== "0") throw new Error("rescheduling setting rows must be removed before migration rollback");
  await db.schema.alterTable("clinic_settings").dropConstraint("clinic_settings_change_kind_check").execute();
  await db.schema.alterTable("clinic_settings").dropColumn("previous_rescheduling_enabled").execute();
  await sql`alter table clinic_settings add constraint clinic_settings_change_kind_check check (
    (setting_kind = 'booking' and previous_after_hours_mode is null and previous_cancellation_enabled is null) or
    (setting_kind = 'afterHours' and previous_booking_enabled is null and previous_cancellation_enabled is null and
      previous_after_hours_mode in ('staffRequest', 'approvedInfoAndRequest') and
      changed_by is not null and changed_at is not null) or
    (setting_kind in ('urgent', 'staffSchedule', 'greeting') and previous_booking_enabled is null and
      previous_after_hours_mode is null and previous_cancellation_enabled is null and
      changed_by is not null and changed_at is not null) or
    (setting_kind = 'cancellation' and previous_booking_enabled is null and previous_after_hours_mode is null and
      previous_cancellation_enabled is not null and changed_by is not null and changed_at is not null and
      policy ? 'cancellationEnabled' and jsonb_typeof(policy->'cancellationEnabled') = 'boolean')
  )`.execute(db);
}
