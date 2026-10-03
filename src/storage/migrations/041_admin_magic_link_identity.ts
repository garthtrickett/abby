import { sql } from "kysely";
import type { Kysely } from "kysely";

/** Standalone administrator authentication only: digests and opaque membership references, no email/patient data. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("admin_sign_in_challenges")
    .addColumn("token_digest", "text", c => c.primaryKey())
    .addColumn("actor_ref", "text", c => c.notNull())
    .addColumn("membership_digest", "text", c => c.notNull())
    .addColumn("created_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addColumn("expires_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp() + interval '10 minutes'`))
    .addCheckConstraint("admin_sign_in_challenges_digest_check", sql`token_digest ~ '^[a-f0-9]{64}$' and membership_digest ~ '^[a-f0-9]{64}$'`)
    .addCheckConstraint("admin_sign_in_challenges_actor_check", sql`actor_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`)
    .addCheckConstraint("admin_sign_in_challenges_expiry_check", sql`expires_at > created_at and expires_at <= created_at + interval '10 minutes 1 second'`)
    .execute();
  await db.schema.createTable("admin_sign_in_sessions")
    .addColumn("token_digest", "text", c => c.primaryKey())
    .addColumn("actor_ref", "text", c => c.notNull())
    .addColumn("membership_digest", "text", c => c.notNull())
    .addColumn("created_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addColumn("idle_expires_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp() + interval '30 minutes'`))
    .addColumn("absolute_expires_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp() + interval '8 hours'`))
    .addCheckConstraint("admin_sign_in_sessions_digest_check", sql`token_digest ~ '^[a-f0-9]{64}$' and membership_digest ~ '^[a-f0-9]{64}$'`)
    .addCheckConstraint("admin_sign_in_sessions_actor_check", sql`actor_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`)
    .addCheckConstraint("admin_sign_in_sessions_expiry_check", sql`idle_expires_at > created_at and idle_expires_at <= absolute_expires_at and absolute_expires_at > created_at and absolute_expires_at <= created_at + interval '8 hours 1 second'`)
    .execute();
  await db.schema.createTable("admin_sign_in_rate_limits")
    .addColumn("key_digest", "text", c => c.primaryKey())
    .addColumn("window_started_at", "timestamptz", c => c.notNull().defaultTo(sql`clock_timestamp()`))
    .addColumn("attempts", "integer", c => c.notNull())
    .addCheckConstraint("admin_sign_in_rate_limits_digest_check", sql`key_digest ~ '^[a-f0-9]{64}$'`)
    .addCheckConstraint("admin_sign_in_rate_limits_count_check", sql`attempts between 1 and 200`).execute();
  await db.schema.createIndex("admin_sign_in_challenges_expiry_idx").on("admin_sign_in_challenges").column("expires_at").execute();
  await db.schema.createIndex("admin_sign_in_sessions_idle_idx").on("admin_sign_in_sessions").column("idle_expires_at").execute();
}
export async function down(db: Kysely<unknown>): Promise<void> {
  // Authentication state is intentionally not portable. An explicit rollback revokes all links/sessions.
  await db.schema.dropTable("admin_sign_in_sessions").execute();
  await db.schema.dropTable("admin_sign_in_challenges").execute();
  await db.schema.dropTable("admin_sign_in_rate_limits").execute();
}
