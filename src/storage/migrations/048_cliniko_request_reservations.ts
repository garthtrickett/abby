import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Short-lived account allocation only; no patient, call, action or credential. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("cliniko_request_reservations")
    .addColumn("lease_ref", "uuid", c => c.primaryKey())
    .addColumn("budget_ref", "text", c => c.notNull().references("cliniko_request_budgets.budget_ref").onDelete("cascade"))
    .addColumn("remaining", "integer", c => c.notNull())
    .addColumn("expires_at_ms", "bigint", c => c.notNull())
    .addCheckConstraint("cliniko_request_reservations_bounds", sql`budget_ref ~ '^[0-9a-f]{64}$' and remaining between 0 and 200 and expires_at_ms > 0`)
    .execute();
  await db.schema.createIndex("cliniko_request_reservations_account").on("cliniko_request_reservations").column("budget_ref").execute();
  // Old workers lock this same account row but do not know about allocations.
  // Reject their claim before provider I/O when it would spend held capacity.
  // New owners decrement their hold before appending a sent timestamp in the
  // same account-locked transaction, leaving total occupancy unchanged.
  await sql`create function cliniko_request_budget_hold_guard() returns trigger
    language plpgsql as $$
    declare occupied bigint;
    begin
      select count(*) into occupied from jsonb_array_elements_text(new.sent_at_ms) as sent(at)
        where sent.at::bigint > floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 60000;
      select occupied + coalesce(sum(remaining), 0) into occupied
        from cliniko_request_reservations where budget_ref = new.budget_ref
        and expires_at_ms > floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
      if occupied > new.max_per_minute then
        raise exception 'Cliniko request capacity is allocated' using errcode = '23514';
      end if;
      return new;
    end $$`.execute(db);
  await sql`create trigger cliniko_request_budget_hold_guard
    before insert or update of sent_at_ms, max_per_minute on cliniko_request_budgets
    for each row execute function cliniko_request_budget_hold_guard()`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
  if (!db.isTransaction) throw new Error("Cliniko allocation rollback requires a migration transaction");
  await sql`lock table cliniko_request_budgets in access exclusive mode`.execute(db);
  await sql`lock table cliniko_request_reservations in access exclusive mode`.execute(db);
  const clock = await sql<{ active: boolean }>`select exists(select 1 from cliniko_request_reservations
    where expires_at_ms > floor(extract(epoch from clock_timestamp()) * 1000)::bigint) as active`.execute(db);
  if (clock.rows[0]?.active !== false) throw new Error("active Cliniko allocations must be retained");
  await sql`drop trigger cliniko_request_budget_hold_guard on cliniko_request_budgets`.execute(db);
  await sql`drop function cliniko_request_budget_hold_guard()`.execute(db);
  await db.schema.dropTable("cliniko_request_reservations").execute();
}
