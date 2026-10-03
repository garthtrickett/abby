import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import { sql } from "kysely";
import { ok, err } from "../../src/core/model.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { PostgresMagicLinkStore } from "../../src/storage/postgres-magic-link-store.ts";
import { identityDigest, MagicLinkIdentity } from "../../src/standalone/identity/magic-link.ts";
import { syntheticAdminAccount } from "../support/magic-link-fixture.ts";
import { scanDisposableBackupCanaries } from "./backup-canary-scan.ts";

assert.equal(process.env.ABBY_ISOLATED_POSTGRES_PROBE, "1", "authentication tests require an isolated database");
assert.ok(process.env.DATABASE_URL);
const db = connectPostgres(process.env.DATABASE_URL), store = new PostgresMagicLinkStore(db);
after(async () => { await db.destroy(); });
const digest = () => identityDigest(randomUUID());
const grant = () => ({ actorRef: `admin-${randomUUID()}`, membershipDigest: digest() });
const keys = () => ({ recipient: digest(), client: digest(), global: digest() });

test("E2E-260 real authentication delivery and session secrets are absent from a disposable PostgreSQL backup", async () => {
  const account = { ...syntheticAdminAccount(), email: `backup-${randomUUID()}@example.test` };
  let link = "";
  const identity = new MagicLinkIdentity({ publicOrigin: "https://backup.example.test", rateKeyHex: "4".repeat(64), store,
    directory: { findByEmail: async email => ok(email === account.email ? account : undefined),
      findByRef: async ref => ok(ref === account.actor.actorRef ? account : undefined) },
    delivery: { send: async (_email, value) => { link = value; return ok(undefined); } } });
  const client = `peer-${randomUUID()}`;
  await identity.requestLink(account.email, client); assert.ok(link);
  const secret = new URL(link).hash.slice(1), signed = await identity.redeemLink(secret); assert.ok(signed.ok);
  assert.deepEqual(await identity.resolveSession(signed.value), ok(account.actor));
  assert.deepEqual(await scanDisposableBackupCanaries(process.env.DATABASE_URL!, [
    { label: "admin_email", value: account.email }, { label: "peer_identifier", value: client },
    { label: "link_secret", value: secret }, { label: "session_secret", value: signed.value },
  ]), []);
  assert.deepEqual(await identity.logout(signed.value), ok(undefined));
});

test("PostgreSQL single-use challenge and session survive new connections and an independent process", async () => {
  const input = grant(), challenge = digest(), session = digest();
  assert.deepEqual(await store.issue(challenge, input), ok(undefined));
  const connection = connectPostgres(process.env.DATABASE_URL!);
  try {
    const other = new PostgresMagicLinkStore(connection);
    assert.deepEqual(await other.readChallenge(challenge), ok(input));
    assert.deepEqual(await other.redeem(challenge, session, input), ok(true));
    assert.deepEqual(await store.readChallenge(challenge), ok(undefined));
    assert.deepEqual(await store.redeem(challenge, digest(), input), ok(false));
    const code = `import { connectPostgres } from './src/storage/connect.ts';
      import { PostgresMagicLinkStore } from './src/storage/postgres-magic-link-store.ts';
      const db = connectPostgres(process.env.DATABASE_URL);
      try { console.log(JSON.stringify(await new PostgresMagicLinkStore(db).readSession(process.argv[1]))); }
      finally { await db.destroy(); }`;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, session], {
      cwd: process.cwd(), env: { DATABASE_URL: process.env.DATABASE_URL! }, timeout: 15_000,
    });
    assert.deepEqual(JSON.parse(result.stdout), ok(input));
    assert.deepEqual(await other.revokeSession(session), ok(undefined));
    assert.deepEqual(await store.readSession(session), ok(undefined));
  } finally { await connection.destroy(); }
});

test("independent PostgreSQL connections redeem one link exactly once", async () => {
  const challenge = digest(), input = grant();
  assert.ok((await store.issue(challenge, input)).ok);
  const connections = Array.from({ length: 4 }, () => connectPostgres(process.env.DATABASE_URL!));
  const sessions = Array.from({ length: 8 }, digest);
  try {
    const results = await Promise.all(sessions.map((session, i) => new PostgresMagicLinkStore(connections[i % 4]!).redeem(challenge, session, input)));
    assert.equal(results.filter(result => result.ok && result.value).length, 1);
    assert.ok(results.every(result => result.ok));
    const rows = await sql<{ count: number }>`select count(*)::integer as count from admin_sign_in_sessions where actor_ref = ${input.actorRef}`.execute(db);
    assert.equal(rows.rows[0]!.count, 1);
  } finally { await Promise.all(connections.map(connection => connection.destroy())); }
});

test("a failed session insertion rolls back link consumption; changed grants cannot redeem", async () => {
  const first = digest(), second = digest(), input = grant(), session = digest();
  assert.ok((await store.issue(first, input)).ok); assert.ok((await store.issue(second, input)).ok);
  assert.deepEqual(await store.redeem(first, session, input), ok(true));
  assert.deepEqual(await store.redeem(second, session, input), err({ kind: "identityUnavailable" }));
  assert.deepEqual(await store.readChallenge(second), ok(input));
  assert.deepEqual(await store.redeem(second, digest(), { ...input, membershipDigest: digest() }), ok(false));
  assert.deepEqual(await store.redeem(second, digest(), input), ok(true));
});

test("PostgreSQL storage time enforces link idle and absolute expiry", async () => {
  const input = grant(), challenge = digest(), session = digest();
  assert.ok((await store.issue(challenge, input)).ok);
  await sql`update admin_sign_in_challenges set created_at = clock_timestamp() - interval '11 minutes',
    expires_at = clock_timestamp() - interval '1 minute' where token_digest = ${challenge}`.execute(db);
  assert.deepEqual(await store.readChallenge(challenge), ok(undefined));
  assert.deepEqual(await store.redeem(challenge, session, input), ok(false));
  const next = digest(); assert.ok((await store.issue(next, input)).ok); assert.deepEqual(await store.redeem(next, session, input), ok(true));
  await sql`update admin_sign_in_sessions set created_at = clock_timestamp() - interval '1 hour',
    idle_expires_at = clock_timestamp() - interval '1 second', absolute_expires_at = clock_timestamp() + interval '4 hours'
    where token_digest = ${session}`.execute(db);
  assert.deepEqual(await store.readSession(session), ok(undefined));
  await sql`update admin_sign_in_sessions set created_at = clock_timestamp() - interval '7 hours 59 minutes',
    idle_expires_at = clock_timestamp() + interval '20 seconds', absolute_expires_at = clock_timestamp() + interval '1 minute'
    where token_digest = ${session}`.execute(db);
  assert.deepEqual(await store.readSession(session), ok(input));
  const bounded = await sql<{ bounded: boolean }>`select idle_expires_at = absolute_expires_at as bounded from admin_sign_in_sessions where token_digest = ${session}`.execute(db);
  assert.equal(bounded.rows[0]!.bounded, true);
  await sql`update admin_sign_in_sessions set created_at = clock_timestamp() - interval '8 hours 1 second',
    idle_expires_at = clock_timestamp() - interval '1 second', absolute_expires_at = clock_timestamp() - interval '1 second'
    where token_digest = ${session}`.execute(db);
  assert.deepEqual(await store.readSession(session), ok(undefined));
});

test("waiting for a PostgreSQL row lock cannot revive a link or idle session that expires during the wait", async () => {
  for (const kind of ["challenge", "session"] as const) {
    const name = `abby_identity_lock_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set("application_name", name);
    const waitingDb = connectPostgres(url.toString()), waitingStore = new PostgresMagicLinkStore(waitingDb);
    const challenge = digest(), session = digest(), input = grant();
    let pending: ReturnType<PostgresMagicLinkStore["redeem"]> | ReturnType<PostgresMagicLinkStore["readSession"]> | undefined;
    try {
      await sql`select 1`.execute(waitingDb);
      assert.ok((await store.issue(challenge, input)).ok);
      if (kind === "session") assert.deepEqual(await store.redeem(challenge, session, input), ok(true));
      const table = kind === "challenge" ? "admin_sign_in_challenges" : "admin_sign_in_sessions";
      const expiry = kind === "challenge" ? "expires_at" : "idle_expires_at", selected = kind === "challenge" ? challenge : session;
      await sql`update ${sql.id(table)} set ${sql.id(expiry)} = clock_timestamp() + interval '1 second' where token_digest = ${selected}`.execute(db);
      await db.transaction().execute(async trx => {
        await sql`select token_digest from ${sql.id(table)} where token_digest = ${selected} for update`.execute(trx);
        pending = kind === "challenge" ? waitingStore.redeem(challenge, session, input) : waitingStore.readSession(session);
        let blocked = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const activity = await sql<{ blocked: boolean }>`select exists(select 1 from pg_stat_activity
            where application_name = ${name} and wait_event_type = 'Lock') as blocked`.execute(trx);
          if (activity.rows[0]!.blocked) { blocked = true; break; }
          await delay(10);
        }
        assert.equal(blocked, true, `${kind} lookup must actually wait on the owned row`);
        const before = await sql<{ valid: boolean }>`select ${sql.id(expiry)} > clock_timestamp() as valid
          from ${sql.id(table)} where token_digest = ${selected}`.execute(trx);
        assert.equal(before.rows[0]!.valid, true, "the token must still be valid when the lock wait is observed");
        await sql`select pg_sleep(1.1)`.execute(trx);
      });
      assert.deepEqual(await pending, kind === "challenge" ? ok(false) : ok(undefined));
    } finally { if (pending) await pending; await waitingDb.destroy(); }
  }
});

test("shared recipient and client budgets refuse excess requests and reset after their stored window", async () => {
  const fixed = keys();
  for (let i = 0; i < 6; i++) assert.deepEqual(await store.reserveRequest(fixed), ok(i < 5));
  await sql`update admin_sign_in_rate_limits set window_started_at = clock_timestamp() - interval '16 minutes'
    where key_digest in (${sql.join(Object.values(fixed))})`.execute(db);
  assert.deepEqual(await store.reserveRequest(fixed), ok(true));
  const client = keys();
  for (let i = 0; i < 21; i++) assert.deepEqual(await store.reserveRequest({ ...client, recipient: digest() }), ok(i < 20));
});

test("the global request budget bounds new subject rows even for unknown recipients", async () => {
  const global = digest(), selected: string[] = [global];
  for (let i = 0; i < 201; i++) {
    const subject = { ...keys(), global }; selected.push(subject.client, subject.recipient);
    assert.deepEqual(await store.reserveRequest(subject), ok(i < 200));
  }
  const rows = await sql<{ count: number }>`select count(*)::integer as count from admin_sign_in_rate_limits
    where key_digest in (${sql.join(selected)})`.execute(db);
  assert.equal(rows.rows[0]!.count, 401);
});

test("invalid raw identifiers cannot enter authentication storage", async () => {
  const input = grant();
  assert.deepEqual(await store.issue("owner@example.test", input), err({ kind: "invalidIdentityInput" }));
  assert.deepEqual(await store.issue(digest(), { ...input, actorRef: "owner@example.test" }), err({ kind: "invalidIdentityInput" }));
  assert.deepEqual(await store.reserveRequest({ recipient: "raw@example.test", client: digest(), global: digest() }), err({ kind: "invalidIdentityInput" }));
  const schema = await sql<{ table_name: string; column_name: string }>`select table_name, column_name from information_schema.columns
    where table_schema = 'public' and table_name like 'admin_sign_in_%'`.execute(db);
  for (const row of schema.rows) assert.equal(/email|patient|phone|call|transcript|password/.test(row.column_name), false);
});
