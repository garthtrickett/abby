import assert from "node:assert/strict";
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ok, err } from "../../src/core/model.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { MagicLinkIdentity } from "../../src/standalone/identity/magic-link.ts";
import { MagicLinkFixture, syntheticAdminAccount } from "../support/magic-link-fixture.ts";

async function withDirectory(run: (path: string, directory: OwnerFileAdminDirectory) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "abby-admin-directory-")), path = join(folder, "accounts.json");
  const account = syntheticAdminAccount();
  try {
    await writeFile(path, JSON.stringify([account]), { mode: 0o600 });
    await run(path, new OwnerFileAdminDirectory(path, account.actor.scope));
  } finally { await rm(folder, { recursive: true, force: true }); }
}

test("E2E-260 owner-only directory reads approved accounts and observes atomic membership replacement without a cache", async () => {
  await withDirectory(async (path, directory) => {
    const account = syntheticAdminAccount();
    assert.deepEqual(await directory.findByEmail(account.email), ok(account));
    assert.deepEqual(await directory.findByRef(account.actor.actorRef), ok(account));
    assert.deepEqual(await directory.findByEmail("unknown@example.test"), ok(undefined));
    const replacement = `${path}.new`;
    await writeFile(replacement, JSON.stringify([{ ...account, actor: { ...account.actor, role: "staff" } }]), { mode: 0o600 });
    await rename(replacement, path);
    assert.deepEqual(await directory.findByRef(account.actor.actorRef), ok({ ...account, actor: { ...account.actor, role: "staff" } }));
    await writeFile(replacement, "[]", { mode: 0o600 }); await rename(replacement, path);
    assert.deepEqual(await directory.findByRef(account.actor.actorRef), ok(undefined));
  });
});

test("malformed ambiguous expanded and foreign directory accounts fail closed", async () => {
  await withDirectory(async (path, directory) => {
    const account = syntheticAdminAccount();
    for (const invalid of [[{ ...account, actor: { ...account.actor, role: "agent" } }],
      [{ ...account, actor: { ...account.actor, actorRef: account.email } }], [{ ...account, providerKey: "synthetic-key" }],
      [{ ...account, actor: { ...account.actor, patientId: "patient-canary" } }],
      [{ ...account, actor: { ...account.actor, scope: { ...account.actor.scope, patientPhone: "+6125550111" } } }],
      [{ ...account, actor: { ...account.actor, scope: { ...account.actor.scope, clinicId: "foreign" } } }],
      [account, account], [account, { ...account, email: "different@example.test" }],
      [account, { ...account, actor: { ...account.actor, actorRef: "different-ref" } }],
      Array.from({ length: 129 }, (_, i) => ({ ...account, email: `owner${i}@example.test`, actor: { ...account.actor, actorRef: `user${i}` } })),
      { accounts: [account] }, [null]]) {
      await writeFile(path, JSON.stringify(invalid));
      assert.deepEqual(await directory.findByEmail(account.email), err({ kind: "identityUnavailable" }));
      assert.deepEqual(await directory.findByRef(account.actor.actorRef), err({ kind: "identityUnavailable" }));
    }
    for (const contents of ["invalid-json", " ".repeat(65_537)]) {
      await writeFile(path, contents); assert.deepEqual(await directory.findByEmail(account.email), err({ kind: "identityUnavailable" }));
    }
  });
});

test("public permissions symlinks directories and missing provisioning are refused", async () => {
  await withDirectory(async (path, directory) => {
    await chmod(path, 0o644);
    assert.deepEqual(await directory.findByEmail("owner@example.test"), err({ kind: "identityUnavailable" }));
    await chmod(path, 0o600);
    const linked = `${path}.link`; await symlink(path, linked);
    const scope = syntheticAdminAccount().actor.scope;
    for (const refused of [linked, join(path, ".."), `${path}.missing`]) {
      assert.deepEqual(await new OwnerFileAdminDirectory(refused, scope).findByRef("user-owner"), err({ kind: "identityUnavailable" }));
    }
    assert.throws(() => new OwnerFileAdminDirectory("relative.json", scope), RangeError);
    assert.throws(() => new OwnerFileAdminDirectory(path, { ...scope, clinicId: "foreign scope" }), RangeError);
  });
});

test("real owner provisioning changes invalidate pending links and sessions even without a revision change", async () => {
  await withDirectory(async (path, directory) => {
    const fixture = new MagicLinkFixture(), account = syntheticAdminAccount();
    const identity = new MagicLinkIdentity({ publicOrigin: "https://admin.example.test", rateKeyHex: "4".repeat(64),
      store: fixture, delivery: fixture.delivery, directory });
    await identity.requestLink(account.email, "client");
    const signed = await identity.redeemLink(new URL(fixture.mail[0]!.link).hash.slice(1)); assert.ok(signed.ok);
    await identity.requestLink(account.email, "client");
    const pending = new URL(fixture.mail[1]!.link).hash.slice(1);
    await writeFile(path, JSON.stringify([{ ...account, actor: { ...account.actor, role: "staff" } }]));
    assert.deepEqual(await identity.resolveSession(signed.value), ok(undefined));
    assert.deepEqual(await identity.redeemLink(pending), err({ kind: "invalidSignInLink" }));
    await writeFile(path, "[]"); await identity.requestLink(account.email, "client");
    assert.equal(fixture.mail.length, 2);
  });
});
