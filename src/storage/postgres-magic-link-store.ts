import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { identityUnavailable, validIdentityDigest, validLoginGrant } from "../standalone/identity/magic-link.ts";
import type { IdentityFailure, LoginGrant, MagicLinkStore } from "../standalone/identity/magic-link.ts";
import type Database from "./generated/Database.ts";
import type { AdminSignInChallengesTokenDigest } from "./generated/public/AdminSignInChallenges.ts";
import type { AdminSignInSessionsTokenDigest } from "./generated/public/AdminSignInSessions.ts";
import type { AdminSignInRateLimitsKeyDigest } from "./generated/public/AdminSignInRateLimits.ts";

const invalidInput = (): Result<never, IdentityFailure> => err({ kind: "invalidIdentityInput" });
function grant(row: Readonly<{ actor_ref: string; membership_digest: string }> | undefined): Result<LoginGrant | undefined, IdentityFailure> {
  if (!row) return ok(undefined);
  const value = { actorRef: row.actor_ref, membershipDigest: row.membership_digest };
  return validLoginGrant(value) ? ok(value) : identityUnavailable();
}

/** Storage time, shared budgets and single-use transactions hold across independent application processes. */
export class PostgresMagicLinkStore implements MagicLinkStore {
  private readonly db: Kysely<Database>;
  constructor(db: Kysely<Database>) { this.db = db; }
  async reserveRequest(keys: Readonly<{ recipient: string; client: string; global: string }>): Promise<Result<boolean, IdentityFailure>> {
    if (!keys || ![keys.recipient, keys.client, keys.global].every(validIdentityDigest) ||
        new Set([keys.recipient, keys.client, keys.global]).size !== 3) return invalidInput();
    const captured = { ...keys };
    try {
      return await this.db.transaction().execute(async trx => {
        await sql`set local statement_timeout = '2s'`.execute(trx);
        // This shared global row orders all budget updates, avoiding crossed-key lock cycles.
        if (!await this.takeBudget(trx, captured.global, 200)) return ok(false);
        await trx.deleteFrom("admin_sign_in_rate_limits")
          .where("window_started_at", "<=", sql<Date>`clock_timestamp() - interval '15 minutes'`)
          .where("key_digest", "!=", captured.global as AdminSignInRateLimitsKeyDigest).execute();
        if (!await this.takeBudget(trx, captured.client, 20)) return ok(false);
        return ok(await this.takeBudget(trx, captured.recipient, 5));
      });
    } catch { return identityUnavailable(); }
  }
  private async takeBudget(trx: Transaction<Database>, digest: string, limit: number): Promise<boolean> {
    const old = sql<boolean>`admin_sign_in_rate_limits.window_started_at <= statement_timestamp() - interval '15 minutes'`;
    const row = await trx.insertInto("admin_sign_in_rate_limits")
      .values({ key_digest: digest as AdminSignInRateLimitsKeyDigest, attempts: 1 })
      .onConflict(conflict => conflict.column("key_digest").doUpdateSet({
        window_started_at: sql<Date>`case when ${old} then statement_timestamp() else admin_sign_in_rate_limits.window_started_at end`,
        attempts: sql<number>`case when ${old} then 1 else admin_sign_in_rate_limits.attempts + 1 end`,
      }).where(sql<boolean>`${old} or admin_sign_in_rate_limits.attempts < ${limit}`))
      .returning("attempts").executeTakeFirst();
    return !!row;
  }
  async issue(digest: string, input: LoginGrant): Promise<Result<void, IdentityFailure>> {
    if (!validIdentityDigest(digest) || !validLoginGrant(input)) return invalidInput();
    const captured = { ...input };
    try {
      await this.db.transaction().execute(async trx => {
        await sql`set local statement_timeout = '2s'`.execute(trx);
        await trx.deleteFrom("admin_sign_in_challenges").where("expires_at", "<=", sql<Date>`clock_timestamp()`).execute();
        await trx.deleteFrom("admin_sign_in_sessions").where("idle_expires_at", "<=", sql<Date>`clock_timestamp()`).execute();
        await trx.insertInto("admin_sign_in_challenges").values({ token_digest: digest as AdminSignInChallengesTokenDigest,
          actor_ref: captured.actorRef, membership_digest: captured.membershipDigest }).execute();
      });
      return ok(undefined);
    } catch { return identityUnavailable(); }
  }
  async readChallenge(digest: string): Promise<Result<LoginGrant | undefined, IdentityFailure>> {
    if (!validIdentityDigest(digest)) return invalidInput();
    try {
      return grant(await this.db.selectFrom("admin_sign_in_challenges").select(["actor_ref", "membership_digest"])
        .where("token_digest", "=", digest as AdminSignInChallengesTokenDigest)
        .where("expires_at", ">", sql<Date>`clock_timestamp()`).executeTakeFirst());
    } catch { return identityUnavailable(); }
  }
  async revokeChallenge(digest: string): Promise<Result<void, IdentityFailure>> {
    if (!validIdentityDigest(digest)) return invalidInput();
    try {
      await this.db.deleteFrom("admin_sign_in_challenges").where("token_digest", "=", digest as AdminSignInChallengesTokenDigest).execute();
      return ok(undefined);
    } catch { return identityUnavailable(); }
  }
  async redeem(challenge: string, session: string, expected: LoginGrant): Promise<Result<boolean, IdentityFailure>> {
    if (!validIdentityDigest(challenge) || !validIdentityDigest(session) || challenge === session || !validLoginGrant(expected)) return invalidInput();
    const captured = { ...expected };
    try {
      return await this.db.transaction().execute(async trx => {
        await sql`set local statement_timeout = '2s'`.execute(trx);
        // Acquire ownership before evaluating expiry; waiting on a row lock cannot revive an expired link.
        await trx.selectFrom("admin_sign_in_challenges").select("token_digest")
          .where("token_digest", "=", challenge as AdminSignInChallengesTokenDigest).forUpdate().executeTakeFirst();
        const consumed = await trx.deleteFrom("admin_sign_in_challenges")
          .where("token_digest", "=", challenge as AdminSignInChallengesTokenDigest).where("expires_at", ">", sql<Date>`clock_timestamp()`)
          .where("actor_ref", "=", captured.actorRef).where("membership_digest", "=", captured.membershipDigest)
          .returning(["actor_ref", "membership_digest"]).executeTakeFirst();
        if (!consumed) return ok(false);
        await trx.insertInto("admin_sign_in_sessions").values({ token_digest: session as AdminSignInSessionsTokenDigest,
          actor_ref: consumed.actor_ref, membership_digest: consumed.membership_digest }).execute();
        return ok(true);
      });
    } catch { return identityUnavailable(); }
  }
  async readSession(digest: string): Promise<Result<LoginGrant | undefined, IdentityFailure>> {
    if (!validIdentityDigest(digest)) return invalidInput();
    try {
      return await this.db.transaction().execute(async trx => {
        await sql`set local statement_timeout = '2s'`.execute(trx);
        await trx.selectFrom("admin_sign_in_sessions").select("token_digest")
          .where("token_digest", "=", digest as AdminSignInSessionsTokenDigest).forUpdate().executeTakeFirst();
        return grant(await trx.updateTable("admin_sign_in_sessions")
          .set({ idle_expires_at: sql<Date>`least(absolute_expires_at, clock_timestamp() + interval '30 minutes')` })
          .where("token_digest", "=", digest as AdminSignInSessionsTokenDigest)
          .where("idle_expires_at", ">", sql<Date>`clock_timestamp()`).where("absolute_expires_at", ">", sql<Date>`clock_timestamp()`)
          .returning(["actor_ref", "membership_digest"]).executeTakeFirst());
      });
    } catch { return identityUnavailable(); }
  }
  async revokeSession(digest: string): Promise<Result<void, IdentityFailure>> {
    if (!validIdentityDigest(digest)) return invalidInput();
    try {
      await this.db.deleteFrom("admin_sign_in_sessions").where("token_digest", "=", digest as AdminSignInSessionsTokenDigest).execute();
      return ok(undefined);
    } catch { return identityUnavailable(); }
  }
}
