import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Irreversible send barrier metadata only; no patient/message/call association. */
export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await db.schema.createTable("confirmation_resend_journal")
    .addColumn("tenant_id", "text", c => c.notNull())
    .addColumn("clinic_id", "text", c => c.notNull())
    .addColumn("location_id", "text", c => c.notNull())
    .addColumn("request_ref", "uuid", c => c.notNull())
    .addColumn("owner_binding", "text", c => c.notNull())
    .addColumn("status", "text", c => c.notNull())
    .addColumn("message_ref", "uuid")
    .addColumn("created_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addColumn("completed_at", "timestamptz")
    .addPrimaryKeyConstraint("confirmation_resend_journal_pk", ["tenant_id", "request_ref"])
    .addCheckConstraint("confirmation_resend_journal_binding", sql`length(tenant_id) between 1 and 256 and
      length(clinic_id) between 1 and 256 and length(location_id) between 1 and 256 and owner_binding ~ '^[a-f0-9]{64}$'`)
    .addCheckConstraint("confirmation_resend_journal_status", sql`
      (status = 'possiblySent' and message_ref is null and completed_at is null) or
      (status in ('definitiveUnsent', 'unknown') and message_ref is null and completed_at is not null) or
      (status = 'accepted' and message_ref is not null and completed_at is not null)`)
    .execute();
  await sql`create trigger confirmation_resend_journal_portability_guard before insert or update or delete
    on confirmation_resend_journal for each row execute function abby_guard_portability_write()`.execute(db);
  await sql`create trigger confirmation_resend_journal_portability_truncate before truncate
    on confirmation_resend_journal for each statement execute function abby_reject_portability_truncate()`.execute(db);
}
export async function down<DB>(db: Kysely<DB>): Promise<void> {
  const state = await sql<{ occupied: boolean; frozen: boolean }>`select
    exists(select 1 from confirmation_resend_journal) as occupied,
    exists(select 1 from tenant_portability_fences where frozen) as frozen`.execute(db);
  if (state.rows[0]?.occupied !== false || state.rows[0]?.frozen !== false) throw new Error("confirmation resend history/fence must be retained");
  await db.schema.dropTable("confirmation_resend_journal").execute();
}
