import { sql } from "kysely";
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("effect_call_leases")
    .addColumn("lease_version", "bigint", column => column.notNull().defaultTo(1))
    .execute();
  await db.schema.alterTable("effect_call_leases").alterColumn("owner_token", column => column.dropNotNull()).execute();
  await sql`alter table effect_call_leases drop constraint effect_call_leases_owner_check`.execute(db);
  await sql`alter table effect_call_leases add constraint effect_call_leases_owner_check
    check (owner_token is null or length(owner_token) between 1 and 256)`.execute(db);
  await sql`alter table effect_call_leases add constraint effect_call_leases_version_check
    check (lease_version >= 1)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from effect_call_leases where owner_token is null`.execute(db);
  await sql`alter table effect_call_leases drop constraint effect_call_leases_version_check`.execute(db);
  await sql`alter table effect_call_leases drop constraint effect_call_leases_owner_check`.execute(db);
  await db.schema.alterTable("effect_call_leases").alterColumn("owner_token", column => column.setNotNull()).execute();
  await sql`alter table effect_call_leases add constraint effect_call_leases_owner_check
    check (length(owner_token) between 1 and 256)`.execute(db);
  await db.schema.alterTable("effect_call_leases").dropColumn("lease_version").execute();
}
