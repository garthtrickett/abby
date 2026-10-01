import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Distinguish location-policy edits so an after-hours change cannot appear in the booking audit. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_settings")
    .addColumn("setting_kind", "text", column => column.notNull().defaultTo("booking"))
    .execute();
  await db.schema.alterTable("clinic_settings")
    .addColumn("previous_after_hours_mode", "text").execute();
  await sql`alter table clinic_settings add constraint clinic_settings_change_kind_check check (
    (setting_kind = 'booking' and previous_after_hours_mode is null) or
    (setting_kind = 'afterHours' and previous_booking_enabled is null and
      previous_after_hours_mode in ('staffRequest', 'approvedInfoAndRequest') and
      changed_by is not null and changed_at is not null)
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_settings").dropConstraint("clinic_settings_change_kind_check").execute();
  await db.schema.alterTable("clinic_settings").dropColumn("previous_after_hours_mode").execute();
  await db.schema.alterTable("clinic_settings").dropColumn("setting_kind").execute();
}
