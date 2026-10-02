import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Public SET-009 preferences and audit only; no recipient, appointment, call or delivery data. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("clinic_notification_settings")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("owners", "jsonb", column => column.notNull())
    .addColumn("notification_kind", "text")
    .addColumn("owner", "text")
    .addColumn("previous_owner", "text")
    .addColumn("changed_by", "text")
    .addColumn("changed_at", "timestamptz")
    .addPrimaryKeyConstraint("clinic_notification_settings_pk", ["tenant_id", "clinic_id", "version"])
    .addCheckConstraint("clinic_notification_settings_scope_check", sql`length(trim(tenant_id)) between 1 and 256 and length(trim(clinic_id)) between 1 and 256`)
    .addCheckConstraint("clinic_notification_settings_owners_check", sql`
      jsonb_typeof(owners) = 'object' and
      owners ?& array['bookingConfirmation', 'cancellationConfirmation', 'reschedulingConfirmation'] and
      owners - array['bookingConfirmation', 'cancellationConfirmation', 'reschedulingConfirmation'] = '{}'::jsonb and
      owners -> 'bookingConfirmation' in ('null'::jsonb, '"host"'::jsonb, '"abby"'::jsonb) and
      owners -> 'cancellationConfirmation' in ('null'::jsonb, '"host"'::jsonb, '"abby"'::jsonb) and
      owners -> 'reschedulingConfirmation' in ('null'::jsonb, '"host"'::jsonb, '"abby"'::jsonb)
    `)
    .addCheckConstraint("clinic_notification_settings_audit_check", sql`
      (version = 0 and owners = '{"bookingConfirmation":null,"cancellationConfirmation":null,"reschedulingConfirmation":null}'::jsonb
        and notification_kind is null and owner is null and previous_owner is null and changed_by is null and changed_at is null) or
      (version > 0 and notification_kind is not null and notification_kind in ('bookingConfirmation', 'cancellationConfirmation', 'reschedulingConfirmation')
        and (owner is null or owner in ('host', 'abby')) and (previous_owner is null or previous_owner in ('host', 'abby'))
        and owners -> notification_kind = coalesce(to_jsonb(owner), 'null'::jsonb)
        and changed_by is not null and length(trim(changed_by)) between 1 and 256 and changed_at is not null)
    `).execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from clinic_notification_settings where version > 0`.execute(db);
  if (rows.rows[0]?.count !== "0") throw new Error("clinic notification setting history must be removed before migration rollback");
  await db.schema.dropTable("clinic_notification_settings").execute();
}
