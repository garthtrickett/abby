import type { Kysely } from "kysely";

// Existing policy versions remain readable, but their actor cannot be reconstructed.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_settings").addColumn("changed_by", "text").execute();
  await db.schema.alterTable("clinic_settings").addColumn("previous_booking_enabled", "boolean").execute();
  await db.schema.alterTable("clinic_settings").addColumn("changed_at", "timestamptz").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("clinic_settings").dropColumn("changed_at").execute();
  await db.schema.alterTable("clinic_settings").dropColumn("previous_booking_enabled").execute();
  await db.schema.alterTable("clinic_settings").dropColumn("changed_by").execute();
}
