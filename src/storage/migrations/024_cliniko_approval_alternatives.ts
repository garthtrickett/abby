import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Two ordered provider-ID pairs only; no patient text or general JSON storage. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("cliniko_catalogue_approvals")
    .addColumn("alternative_1_practitioner_id", "text")
    .addColumn("alternative_1_appointment_type_id", "text")
    .addColumn("alternative_2_practitioner_id", "text")
    .addColumn("alternative_2_appointment_type_id", "text")
    .execute();
  await sql`alter table cliniko_catalogue_approvals add constraint cliniko_catalogue_alternatives_check check (
    (alternative_1_practitioner_id is null) = (alternative_1_appointment_type_id is null) and
    (alternative_2_practitioner_id is null) = (alternative_2_appointment_type_id is null) and
    (alternative_2_practitioner_id is null or alternative_1_practitioner_id is not null) and
    (approved or alternative_1_practitioner_id is null) and
    (alternative_1_practitioner_id is null or (
      alternative_1_practitioner_id ~ '^[1-9][0-9]{0,19}$' and
      alternative_1_appointment_type_id ~ '^[1-9][0-9]{0,19}$' and
      (alternative_1_practitioner_id, alternative_1_appointment_type_id) is distinct from
        (practitioner_id, appointment_type_id))) and
    (alternative_2_practitioner_id is null or (
      alternative_2_practitioner_id ~ '^[1-9][0-9]{0,19}$' and
      alternative_2_appointment_type_id ~ '^[1-9][0-9]{0,19}$' and
      (alternative_2_practitioner_id, alternative_2_appointment_type_id) is distinct from
        (practitioner_id, appointment_type_id) and
      (alternative_2_practitioner_id, alternative_2_appointment_type_id) is distinct from
        (alternative_1_practitioner_id, alternative_1_appointment_type_id)))
  )`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table cliniko_catalogue_approvals drop constraint cliniko_catalogue_alternatives_check`.execute(db);
  await db.schema.alterTable("cliniko_catalogue_approvals")
    .dropColumn("alternative_1_practitioner_id")
    .dropColumn("alternative_1_appointment_type_id")
    .dropColumn("alternative_2_practitioner_id")
    .dropColumn("alternative_2_appointment_type_id")
    .execute();
}
