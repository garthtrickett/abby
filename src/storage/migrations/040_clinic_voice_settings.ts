import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Public locale/voice preferences and audit; no patient, call, speech text or provider credentials. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("clinic_voice_settings")
    .addColumn("tenant_id", "text", column => column.notNull())
    .addColumn("clinic_id", "text", column => column.notNull())
    .addColumn("version", "integer", column => column.notNull())
    .addColumn("locale", "text")
    .addColumn("voice_id", "text")
    .addColumn("setting_kind", "text")
    .addColumn("setting_value", "text")
    .addColumn("previous_value", "text")
    .addColumn("changed_by", "text")
    .addColumn("changed_at", "timestamptz")
    .addPrimaryKeyConstraint("clinic_voice_settings_pk", ["tenant_id", "clinic_id", "version"])
    .addCheckConstraint("clinic_voice_settings_scope_check", sql`length(trim(tenant_id)) between 1 and 256 and length(trim(clinic_id)) between 1 and 256`)
    .addCheckConstraint("clinic_voice_settings_values_check", sql`
      (locale is null or (length(locale) between 1 and 80 and locale ~ '^[a-zA-Z0-9-]+$')) and
      (voice_id is null or voice_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')
    `)
    .addCheckConstraint("clinic_voice_settings_audit_check", sql`
      (version = 0 and locale is null and voice_id is null and setting_kind is null and setting_value is null
        and previous_value is null and changed_by is null and changed_at is null) or
      (version > 0 and setting_kind is not null and setting_kind in ('locale', 'voiceId')
        and ((setting_kind = 'locale' and setting_value is not distinct from locale
          and (previous_value is null or (length(previous_value) between 1 and 80 and previous_value ~ '^[a-zA-Z0-9-]+$')))
          or (setting_kind = 'voiceId' and setting_value is not distinct from voice_id
          and (previous_value is null or previous_value ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$')))
        and changed_by is not null and length(trim(changed_by)) between 1 and 256 and changed_at is not null)
    `).execute();
  await sql`create trigger clinic_voice_settings_portability_guard
    before insert or update or delete on clinic_voice_settings
    for each row execute function abby_guard_portability_write()`.execute(db);
  await sql`create trigger clinic_voice_settings_portability_truncate
    before truncate on clinic_voice_settings
    for each statement execute function abby_reject_portability_truncate()`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  const rows = await sql<{ count: string }>`select count(*)::text as count from clinic_voice_settings where version > 0`.execute(db);
  if (rows.rows[0]?.count !== "0") throw new Error("clinic voice setting history must be removed before migration rollback");
  await db.schema.dropTable("clinic_voice_settings").execute();
}
