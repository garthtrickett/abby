import assert from "node:assert/strict";
import test from "node:test";
import { err, ok } from "../../src/core/model.ts";
import { MagicLinkIdentity, identityDigest, newIdentitySecret, normalizeAdminEmail, validIdentitySecret } from "../../src/standalone/identity/magic-link.ts";
import { MagicLinkFixture, syntheticAdminAccount } from "../support/magic-link-fixture.ts";

const linkSecret = (fixture: MagicLinkFixture): string => new URL(fixture.mail.at(-1)!.link).hash.slice(1);
async function requested(): Promise<MagicLinkFixture> {
  const fixture = new MagicLinkFixture(), account = syntheticAdminAccount();
  fixture.accounts.set(account.email, account);
  await fixture.identity.requestLink(account.email, "client-test");
  return fixture;
}

test("magic link confirmation identifies a preprovisioned account without consuming the link", async () => {
  const fixture = await requested(), secret = linkSecret(fixture);
  assert.equal(fixture.mail.length, 1);
  assert.equal(validIdentitySecret(secret), true);
  assert.deepEqual(await fixture.identity.inspectLink(secret), ok({ email: "owner@example.test" }));
  assert.equal(fixture.sessions.size, 0);
  assert.equal(fixture.challenges.size, 1);
  const redeemed = await fixture.identity.redeemLink(secret);
  assert.ok(redeemed.ok);
  const session = redeemed.value;
  assert.notEqual(session, secret);
  assert.deepEqual(await fixture.identity.resolveSession(session), ok(syntheticAdminAccount().actor));
  assert.deepEqual(await fixture.identity.redeemLink(secret), err({ kind: "invalidSignInLink" }));
  assert.equal(fixture.sessions.size, 1);
  assert.deepEqual(await fixture.identity.logout(session), ok(undefined));
  assert.deepEqual(await fixture.identity.resolveSession(session), ok(undefined));
  assert.deepEqual(await fixture.identity.logout(session), ok(undefined));
});

test("unknown throttled malformed and agent accounts produce no mail or authority", async () => {
  const fixture = new MagicLinkFixture(), account = syntheticAdminAccount();
  fixture.accounts.set(account.email, { ...account, actor: { ...account.actor, role: "agent" } });
  for (const input of ["unknown@example.test", account.email, "bad\r\nTo: victim@example.test", "", null, { email: account.email }]) {
    assert.equal(await fixture.identity.requestLink(input, "client-test"), undefined);
  }
  fixture.accounts.set(account.email, account); fixture.allowed = false;
  await fixture.identity.requestLink(account.email, "client-test");
  assert.equal(fixture.mail.length, 0); assert.equal(fixture.challenges.size, 0); assert.equal(fixture.sessions.size, 0);
  assert.deepEqual(await fixture.identity.resolveSession(newIdentitySecret()), ok(undefined));
});

test("concurrent link redemption has one winner and stores only token digests and opaque grants", async () => {
  const fixture = await requested(), secret = linkSecret(fixture);
  const results = await Promise.all(Array.from({ length: 8 }, () => fixture.identity.redeemLink(secret)));
  const accepted = results.filter(result => result.ok);
  assert.equal(accepted.length, 1); assert.equal(fixture.sessions.size, 1);
  assert.ok(accepted[0]!.ok);
  const session = accepted[0]!.value;
  const stored = JSON.stringify({ challenges: [...fixture.challenges], sessions: [...fixture.sessions], rateKeys: fixture.rateKeys });
  for (const canary of [secret, session, "owner@example.test", "client-test"]) assert.equal(stored.includes(canary), false);
  assert.ok(fixture.sessions.has(identityDigest(session)));
});

test("expiry and revoked membership deny pending links and active sessions", async () => {
  const expired = await requested(); expired.now = 600_000;
  assert.deepEqual(await expired.identity.inspectLink(linkSecret(expired)), err({ kind: "invalidSignInLink" }));
  assert.deepEqual(await expired.identity.redeemLink(linkSecret(expired)), err({ kind: "invalidSignInLink" }));
  const revoked = await requested(); revoked.accounts.clear();
  assert.deepEqual(await revoked.identity.redeemLink(linkSecret(revoked)), err({ kind: "invalidSignInLink" }));
  assert.equal(revoked.sessions.size, 0);
  const active = await requested(), signed = await active.identity.redeemLink(linkSecret(active)); assert.ok(signed.ok);
  active.accounts.clear(); assert.deepEqual(await active.identity.resolveSession(signed.value), ok(undefined));
});

test("email role location tenant and clinic changes invalidate old authority even without a revision bump", async () => {
  for (const changed of ["email", "role", "locationId", "clinicId", "tenantId", "membershipVersion"] as const) {
    const fixture = await requested(), signed = await fixture.identity.redeemLink(linkSecret(fixture)); assert.ok(signed.ok);
    await fixture.identity.requestLink("owner@example.test", "client-test");
    const account = structuredClone(syntheticAdminAccount());
    const updated = changed === "email" ? { ...account, email: "new@example.test" }
      : changed === "role" ? { ...account, actor: { ...account.actor, role: "staff" as const } }
      : changed === "membershipVersion" ? { ...account, membershipVersion: "membership-2" }
      : { ...account, actor: { ...account.actor, scope: { ...account.actor.scope, [changed]: "foreign" } } };
    fixture.accounts.set("owner@example.test", updated);
    assert.deepEqual(await fixture.identity.resolveSession(signed.value), ok(undefined), changed);
    assert.deepEqual(await fixture.identity.redeemLink(linkSecret(fixture)), err({ kind: "invalidSignInLink" }), changed);
  }
});

test("failed delivery invalidates the issued link and failed logout does not claim success", async () => {
  const fixture = new MagicLinkFixture(), account = syntheticAdminAccount(); fixture.accounts.set(account.email, account);
  let sent = "";
  const identity = new MagicLinkIdentity({ publicOrigin: "https://admin.example.test", rateKeyHex: "4".repeat(64), store: fixture,
    directory: { findByEmail: async () => ok(account), findByRef: async () => ok(account) },
    delivery: { send: async (_email, link) => { sent = new URL(link).hash.slice(1); return err({ kind: "identityUnavailable" }); } } });
  await identity.requestLink(account.email, "client-test");
  assert.deepEqual(await identity.redeemLink(sent), err({ kind: "invalidSignInLink" }));
  assert.equal(fixture.challenges.size, 0);
  fixture.revokeSession = async () => err({ kind: "identityUnavailable" });
  assert.deepEqual(await identity.logout(newIdentitySecret()), err({ kind: "identityUnavailable" }));
});

test("identity rejects noncanonical secrets and email injection while preserving plus addressing", () => {
  assert.equal(normalizeAdminEmail("owner+test@EXAMPLE.test"), "owner+test@example.test");
  for (const value of ["a..b@example.test", "a@-example.test", "a@example..test", "a@example.test\n", "a@b", "<a>@example.test"]) assert.equal(normalizeAdminEmail(value), undefined);
  for (const value of ["", "x".repeat(42), "x".repeat(43), "!".repeat(43), null]) assert.equal(validIdentitySecret(value), false);
});

test("identity startup rejects untrusted insecure expanded and port-zero origins", () => {
  const fixture = new MagicLinkFixture();
  const config = { store: fixture, delivery: fixture.delivery, rateKeyHex: "4".repeat(64),
    directory: { findByEmail: async () => ok(undefined), findByRef: async () => ok(undefined) } };
  for (const publicOrigin of ["invalid", "http://admin.example.test", "http://127.0.0.1:1234",
    "https://admin.example.test/return", "https://admin.example.test?return=foreign", "https://admin.example.test#token",
    "https://user:password@admin.example.test", "https://admin.example.test:0"]) {
    assert.throws(() => new MagicLinkIdentity({ ...config, publicOrigin }), RangeError);
  }
  assert.throws(() => new MagicLinkIdentity({ ...config, publicOrigin: "http://127.0.0.1:0", isolatedLoopback: true }), RangeError);
  assert.doesNotThrow(() => new MagicLinkIdentity({ ...config, publicOrigin: "http://127.0.0.1:1234", isolatedLoopback: true }));
  assert.equal(fixture.challenges.size, 0); assert.equal(fixture.sessions.size, 0);
});

test("an uncooperative mail port is bounded and its challenge is invalidated without retry", async () => {
  const fixture = new MagicLinkFixture(), account = syntheticAdminAccount();
  let attempts = 0, signal: AbortSignal | undefined, secret = "";
  const identity = new MagicLinkIdentity({ publicOrigin: "https://admin.example.test", rateKeyHex: "4".repeat(64), store: fixture,
    directory: { findByEmail: async () => ok(account), findByRef: async () => ok(account) },
    delivery: { send: async (_email, link, abort) => { attempts++; signal = abort; secret = new URL(link).hash.slice(1); return new Promise(() => {}); } } });
  await identity.requestLink(account.email, "client-test");
  assert.equal(attempts, 1); assert.equal(signal?.aborted, true);
  assert.equal(fixture.challenges.size, 0);
  assert.deepEqual(await identity.redeemLink(secret), err({ kind: "invalidSignInLink" }));
});
