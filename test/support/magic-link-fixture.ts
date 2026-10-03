import { ok } from "../../src/core/model.ts";
import type { Result } from "../../src/core/model.ts";
import type { AdminAccount, IdentityFailure, LoginGrant, MagicLinkDelivery, MagicLinkStore } from "../../src/standalone/identity/magic-link.ts";
import { MagicLinkIdentity } from "../../src/standalone/identity/magic-link.ts";

/** Deterministic port fixture, not production persistence or delivered-email evidence. */
export class MagicLinkFixture implements MagicLinkStore {
  now = 0;
  allowed = true;
  readonly accounts = new Map<string, AdminAccount>();
  readonly mail: Readonly<{ email: string; link: string }>[] = [];
  readonly rateKeys: unknown[] = [];
  readonly challenges = new Map<string, { grant: LoginGrant; expires: number }>();
  readonly sessions = new Map<string, { grant: LoginGrant; idle: number; absolute: number }>();
  readonly delivery: MagicLinkDelivery = { send: async (email, link) => { this.mail.push({ email, link }); return ok(undefined); } };
  readonly identity = new MagicLinkIdentity({ publicOrigin: "https://admin.example.test", rateKeyHex: "4".repeat(64),
    store: this, delivery: this.delivery, directory: {
      findByEmail: async email => ok(this.accounts.get(email)),
      findByRef: async ref => ok([...this.accounts.values()].find(account => account.actor.actorRef === ref)),
    } });
  async reserveRequest(keys: unknown): Promise<Result<boolean, IdentityFailure>> { this.rateKeys.push(keys); return ok(this.allowed); }
  async issue(digest: string, grant: LoginGrant): Promise<Result<void, IdentityFailure>> {
    this.challenges.set(digest, { grant: structuredClone(grant), expires: this.now + 600_000 }); return ok(undefined);
  }
  async readChallenge(digest: string): Promise<Result<LoginGrant | undefined, IdentityFailure>> {
    const row = this.challenges.get(digest);
    return ok(row && this.now < row.expires ? structuredClone(row.grant) : undefined);
  }
  async revokeChallenge(digest: string): Promise<Result<void, IdentityFailure>> { this.challenges.delete(digest); return ok(undefined); }
  async redeem(digest: string, session: string, grant: LoginGrant): Promise<Result<boolean, IdentityFailure>> {
    const row = this.challenges.get(digest);
    if (!row || this.now >= row.expires || row.grant.actorRef !== grant.actorRef || row.grant.membershipDigest !== grant.membershipDigest) return ok(false);
    this.challenges.delete(digest);
    this.sessions.set(session, { grant: structuredClone(grant), idle: this.now + 1_800_000, absolute: this.now + 28_800_000 });
    return ok(true);
  }
  async readSession(digest: string): Promise<Result<LoginGrant | undefined, IdentityFailure>> {
    const row = this.sessions.get(digest);
    if (!row || this.now >= Math.min(row.idle, row.absolute)) return ok(undefined);
    row.idle = Math.min(this.now + 1_800_000, row.absolute);
    return ok(structuredClone(row.grant));
  }
  async revokeSession(digest: string): Promise<Result<void, IdentityFailure>> { this.sessions.delete(digest); return ok(undefined); }
}

export function syntheticAdminAccount(): AdminAccount {
  return { email: "owner@example.test", membershipVersion: "membership-1", actor: { actorRef: "user-owner",
    role: "clinicAdmin", scope: { tenantId: "identity-tenant", clinicId: "clinic", locationId: "location" } } };
}
