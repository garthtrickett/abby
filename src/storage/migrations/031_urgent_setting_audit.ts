import { sql } from "kysely";
import type { Kysely } from "kysely";

/** A public urgent-script edit has its own audit kind, separate from booking and after-hours. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_settings").dropConstraint("clinic_settings_change_kind_check").execute();
  await sql`alter table clinic_settings add constraint clinic_settings_change_kind_check check (
    (setting_kind = 'booking' and previous_after_hours_mode is null) or
    (setting_kind = 'afterHours' and previous_booking_enabled is null and
      previous_after_hours_mode in ('staffRequest', 'approvedInfoAndRequest') and
      changed_by is not null and changed_at is not null) or
    (setting_kind = 'urgent' and previous_booking_enabled is null and
      previous_after_hours_mode is null and changed_by is not null and changed_at is not null)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const urgent = await sql<{ count: string }>`select count(*)::text as count from clinic_settings where setting_kind = 'urgent'`.execute(db);
  if (urgent.rows[0]?.count !== "0") throw new Error("urgent setting rows must be removed before migration rollback");
  await db.schema.alterTable("clinic_settings").dropConstraint("clinic_settings_change_kind_check").execute();
  await sql`alter table clinic_settings add constraint clinic_settings_change_kind_check check (
    (setting_kind = 'booking' and previous_after_hours_mode is null) or
    (setting_kind = 'afterHours' and previous_booking_enabled is null and
      previous_after_hours_mode in ('staffRequest', 'approvedInfoAndRequest') and
      changed_by is not null and changed_at is not null)
  )`.execute(db);
}
