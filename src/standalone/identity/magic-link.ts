import { createHash, createHmac, randomBytes } from "node:crypto";
import { err, ok } from "../../core/model.ts";
import type { Result } from "../../core/model.ts";
import type { HostActor } from "../../reference/command-gateway.ts";

export type IdentityFailure = Readonly<{ kind: "identityUnavailable" | "invalidIdentityInput" | "invalidSignInLink" }>;
export type AdminAccount = Readonly<{ email: string; actor: HostActor; membershipVersion: string }>;
export interface AdminDirectory {
  findByEmail(email: string): Promise<Result<AdminAccount | undefined, IdentityFailure>>;
  findByRef(actorRef: string): Promise<Result<AdminAccount | undefined, IdentityFailure>>;
}
export type LoginGrant = Readonly<{ actorRef: string; membershipDigest: string }>;
export interface MagicLinkStore {
  reserveRequest(keys: Readonly<{ recipient: string; client: string; global: string }>): Promise<Result<boolean, IdentityFailure>>;
  issue(digest: string, grant: LoginGrant): Promise<Result<void, IdentityFailure>>;
  readChallenge(digest: string): Promise<Result<LoginGrant | undefined, IdentityFailure>>;
  revokeChallenge(digest: string): Promise<Result<void, IdentityFailure>>;
  /** Expiry, single use and session creation are checked atomically using storage-owned time. */
  redeem(challengeDigest: string, sessionDigest: string, expectedGrant: LoginGrant): Promise<Result<boolean, IdentityFailure>>;
  /** Enforces idle/absolute expiry and updates the idle deadline atomically. */
  readSession(digest: string): Promise<Result<LoginGrant | undefined, IdentityFailure>>;
  revokeSession(digest: string): Promise<Result<void, IdentityFailure>>;
}
export interface MagicLinkDelivery {
  send(email: string, link: string, signal: AbortSignal): Promise<Result<void, IdentityFailure>>;
}
export const identityUnavailable = (): Result<never, IdentityFailure> => err({ kind: "identityUnavailable" });
const invalidLink = (): Result<never, IdentityFailure> => err({ kind: "invalidSignInLink" });
export const identityDigest = (secret: string): string => createHash("sha256").update(secret).digest("hex");
export const newIdentitySecret = (): string => randomBytes(32).toString("base64url");
export const validIdentityDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validLoginGrant(value: LoginGrant): boolean {
  return !!value && typeof value.actorRef === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.actorRef) &&
    validIdentityDigest(value.membershipDigest);
}
export function validIdentitySecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value;
}
export function normalizeAdminEmail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 254 || /[\r\n\u0000]/.test(value)) return undefined;
  const email = value.trim(), at = email.lastIndexOf("@");
  if (at < 1 || at > 64 || email.indexOf("@") !== at) return undefined;
  const local = email.slice(0, at), domain = email.slice(at + 1).toLowerCase();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      !domain.includes(".") || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  return `${local}@${domain}`;
}
function opaque(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function validAccount(account: AdminAccount): boolean {
  return !!account && normalizeAdminEmail(account.email) === account.email && opaque(account.membershipVersion) &&
    !!account.actor && ["clinicAdmin", "staff"].includes(account.actor.role) &&
    typeof account.actor.actorRef === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(account.actor.actorRef) &&
    !!account.actor.scope && [account.actor.scope.tenantId, account.actor.scope.clinicId, account.actor.scope.locationId].every(opaque);
}
function sameGrant(account: AdminAccount, grant: LoginGrant): boolean {
  return validAccount(account) && account.actor.actorRef === grant.actorRef && membershipDigest(account) === grant.membershipDigest;
}
function membershipDigest(account: AdminAccount): string {
  const { actorRef, role, scope } = account.actor;
  return identityDigest(JSON.stringify([account.membershipVersion, account.email, actorRef, role, scope.tenantId, scope.clinicId, scope.locationId]));
}

/** Owns authentication only. Trusted current directory membership supplies all clinic authority. */
export class MagicLinkIdentity {
  readonly origin: string;
  private readonly store: MagicLinkStore;
  private readonly directory: AdminDirectory;
  private readonly delivery: MagicLinkDelivery;
  private readonly rateKey: string;
  constructor(config: Readonly<{ publicOrigin: string; store: MagicLinkStore; directory: AdminDirectory;
    delivery: MagicLinkDelivery; rateKeyHex: string; isolatedLoopback?: boolean }>) {
    let origin: URL;
    try { origin = new URL(config.publicOrigin); }
    catch { throw new RangeError("invalid identity configuration"); }
    if (origin.origin !== config.publicOrigin || origin.username || origin.password ||
        (origin.protocol !== "https:" && !(config.isolatedLoopback === true && origin.protocol === "http:" && origin.hostname === "127.0.0.1")) ||
        origin.port === "0" || !/^[a-f0-9]{64}$/.test(config.rateKeyHex)) throw new RangeError("invalid identity configuration");
    this.origin = origin.origin; this.store = config.store; this.directory = config.directory;
    this.delivery = config.delivery; this.rateKey = config.rateKeyHex;
  }
  private rateDigest(kind: string, value: string): string {
    return createHmac("sha256", Buffer.from(this.rateKey, "hex")).update(JSON.stringify([this.origin, kind, value])).digest("hex");
  }
  /** Fixed public response: this does not claim that an account exists or that email was delivered. */
  async requestLink(input: unknown, clientIdentity: string): Promise<void> {
    const email = normalizeAdminEmail(input);
    if (!email || !opaque(clientIdentity)) return;
    try {
      const allowed = await this.store.reserveRequest({ recipient: this.rateDigest("recipient", email),
        client: this.rateDigest("client", clientIdentity), global: this.rateDigest("global", "all") });
      if (!allowed.ok || !allowed.value) return;
      const found = await this.directory.findByEmail(email);
      if (!found.ok || !found.value || !validAccount(found.value) || found.value.email !== email) return;
      const account = structuredClone(found.value), secret = newIdentitySecret(), digest = identityDigest(secret);
      const issued = await this.store.issue(digest, { actorRef: account.actor.actorRef, membershipDigest: membershipDigest(account) });
      if (!issued.ok) return;
      const controller = new AbortController();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<Result<void, IdentityFailure>>(resolve => {
          deadline = setTimeout(() => { controller.abort(); resolve(identityUnavailable()); }, 5_000);
        });
        const sent = await Promise.race([Promise.resolve().then(() =>
          this.delivery.send(email, `${this.origin}/sign-in/confirm#${secret}`, controller.signal)), timeout]);
        if (!sent.ok || controller.signal.aborted) await this.store.revokeChallenge(digest);
      } catch { await this.store.revokeChallenge(digest); }
      finally { if (deadline !== undefined) clearTimeout(deadline); }
    } catch { /* No account, address, token, provider or storage detail is exposed. */ }
  }
  private async accountFor(grant: LoginGrant): Promise<Result<AdminAccount, IdentityFailure>> {
    const current = await this.directory.findByRef(grant.actorRef);
    return current.ok && current.value && sameGrant(current.value, grant) ? ok(structuredClone(current.value))
      : current.ok ? invalidLink() : current;
  }
  /** Token holder sees the account for an explicit confirmation; GET requests never call redemption. */
  async inspectLink(secret: unknown): Promise<Result<Readonly<{ email: string }>, IdentityFailure>> {
    if (!validIdentitySecret(secret)) return invalidLink();
    try {
      const grant = await this.store.readChallenge(identityDigest(secret));
      if (!grant.ok) return grant;
      if (!grant.value) return invalidLink();
      const account = await this.accountFor(grant.value);
      return account.ok ? ok({ email: account.value.email }) : account;
    } catch { return identityUnavailable(); }
  }
  async redeemLink(secret: unknown): Promise<Result<string, IdentityFailure>> {
    if (!validIdentitySecret(secret)) return invalidLink();
    try {
      const grant = await this.store.readChallenge(identityDigest(secret));
      if (!grant.ok) return grant;
      if (!grant.value) return invalidLink();
      const expected = structuredClone(grant.value);
      const account = await this.accountFor(expected);
      if (!account.ok) return account;
      const session = newIdentitySecret();
      const redeemed = await this.store.redeem(identityDigest(secret), identityDigest(session), expected);
      return redeemed.ok ? redeemed.value ? ok(session) : invalidLink() : redeemed;
    } catch { return identityUnavailable(); }
  }
  async resolveSession(secret: unknown): Promise<Result<HostActor | undefined, IdentityFailure>> {
    if (!validIdentitySecret(secret)) return ok(undefined);
    try {
      const grant = await this.store.readSession(identityDigest(secret));
      if (!grant.ok) return grant;
      if (!grant.value) return ok(undefined);
      const account = await this.accountFor(structuredClone(grant.value));
      return account.ok ? ok(account.value.actor) : account.error.kind === "invalidSignInLink" ? ok(undefined) : account;
    } catch { return identityUnavailable(); }
  }
  async logout(secret: unknown): Promise<Result<void, IdentityFailure>> {
    if (!validIdentitySecret(secret)) return ok(undefined);
    try { return await this.store.revokeSession(identityDigest(secret)); }
    catch { return identityUnavailable(); }
  }
}
