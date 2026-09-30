import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Append-only clinic configuration. No credential, patient, call, or appointment fields. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("cliniko_catalogue_approvals")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("location_id", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("approved", "boolean", column => column.notNull())
    .addColumn("account_ref", "text")
    .addColumn("dialed_number", "text")
    .addColumn("route_version", "text")
    .addColumn("business_id", "text")
    .addColumn("practitioner_id", "text")
    .addColumn("appointment_type_id", "text")
    .addColumn("policy_version", "text")
    .addColumn("credential_fingerprint", "text")
    .addColumn("catalogue_observed_at", "timestamptz")
    .addColumn("approved_at", "timestamptz")
    .addColumn("changed_by", "text", column => column.notNull())
    .addColumn("changed_at", "timestamptz", column => column.notNull().defaultTo(sql`clock_timestamp()`))
    .addPrimaryKeyConstraint("cliniko_catalogue_approvals_pk", ["tenant_id", "clinic_id", "location_id", "version"])
    .addCheckConstraint("cliniko_catalogue_approvals_check", sql`
      tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
      clinic_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
      location_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
      changed_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and version >= 0 and
      ((not approved and account_ref is null and dialed_number is null and route_version is null and
        business_id is null and practitioner_id is null and appointment_type_id is null and
        policy_version is null and credential_fingerprint is null and catalogue_observed_at is null and approved_at is null) or
       (approved and version > 0 and num_nonnulls(account_ref, dialed_number, route_version, business_id,
        practitioner_id, appointment_type_id, policy_version, credential_fingerprint,
        catalogue_observed_at, approved_at) = 10 and account_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
        dialed_number ~ '^[+][1-9][0-9]{1,14}$' and route_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$' and
        business_id ~ '^[1-9][0-9]*$' and practitioner_id ~ '^[1-9][0-9]*$' and
        appointment_type_id ~ '^[1-9][0-9]*$' and policy_version ~ '^[A-Za-z0-9._-]{1,128}$' and
        credential_fingerprint ~ '^[0-9a-f]{64}$' and catalogue_observed_at is not null and
        approved_at is not null and approved_at >= catalogue_observed_at))`)
    .execute();
}

/** Disposable test databases only; deployed hosts preserve approval history. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("cliniko_catalogue_approvals").execute();
}
