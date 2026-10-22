// R24: real budget-owner failures must not contaminate a later borrower.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Client, Pool } from "pg";
import type Database from "../../src/storage/generated/Database.ts";
import type { ClinikoBudgetOperationalEvent } from "../../src/cliniko/read-budget.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";

type Fixture = Readonly<{ db: Kysely<Database>; observer: Client; pid: number; apiKey: string;
  budgetRef: string; events: ClinikoBudgetOperationalEvent[] }>;
const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 45_000 };

/** A fresh migrated database inside the already admitted test server. One pool
 * slot makes reuse observable; the independent backend witnesses durability. */
async function fixture(run: (f: Fixture) => Promise<void>) {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl && process.env.ABBY_ISOLATED_POSTGRES_PROBE === "1");
  const name = `abby_budget_tx_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000,
    options: "-c statement_timeout=5000" });
  let db: Kysely<Database> | undefined, observer: Client | undefined, created = false;
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`); created = true;
    const pool = new Pool({ connectionString: target.toString(), max: 1, idleTimeoutMillis: 0,
      allowExitOnIdle: true, connectionTimeoutMillis: 5_000, options: "-c statement_timeout=5000" });
    pool.on("error", () => {});
    pool.on("connect", client => client.on("error", () => {}));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    await migrate(db);
    await sql`create table abby_tx_probe (id uuid primary key)`.execute(db);
    observer = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 5_000,
      options: "-c statement_timeout=5000" });
    observer.on("error", () => {}); await observer.connect();
    const pid = await backend(db);
    assert.notEqual(pid, (await observer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid);
    const apiKey = `synthetic-transaction-${randomUUID()}-au5`;
    await run({ db, observer, pid, apiKey,
      budgetRef: createHash("sha256").update(`abby-cliniko-budget-v1\0${apiKey}`).digest("hex"), events: [] });
  } finally {
    // Force-drop only this generated database before ending the pool, so a
    // failed ownership assertion cannot strand a checked-out fixture backend.
    try { await observer?.end(); }
    finally {
      try { if (created) await admin.query(`drop database if exists "${name}" with (force)`); }
      finally { try { await db?.destroy(); } finally { await admin.end(); } }
    }
  }
}

async function backend(db: Kysely<Database>): Promise<number> {
  return (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db)).rows[0]!.pid;
}
function budget(f: Fixture, db = f.db) {
  return new PostgresClinikoRequestBudget(db, { apiKey: f.apiKey, maxPerMinute: 1,
    onEvent: event => { f.events.push(event); } });
}

async function nextBorrower(f: Fixture) {
  const previous = await f.observer.query<{ state: string; open: boolean }>(
    "select state, xact_start is not null as open from pg_stat_activity where pid=$1", [f.pid]);
  assert.ok(previous.rows.every(row => row.state === "idle" && !row.open),
    "the previous backend must be idle outside a transaction or have been discarded");
  const pid = await backend(f.db), id = randomUUID();
  // Deliberately autocommit: beginning another transaction could hide an old
  // leaked transaction by committing it along with the next operation.
  await sql`insert into abby_tx_probe (id) values (${id}::uuid)`.execute(f.db);
  assert.equal((await f.observer.query("select id from abby_tx_probe where id=$1", [id])).rowCount, 1,
    "another backend must observe the acknowledged write before any cleanup");
  assert.equal(await backend(f.db), pid, "the sibling write and stale rollback use the same pool backend");
  await sql`rollback`.execute(f.db);
  assert.equal((await f.observer.query("select id from abby_tx_probe where id=$1", [id])).rowCount, 1,
    "a stale rollback must not discard an already acknowledged sibling write");
}

async function installFailure(f: Fixture, mode: "statement" | "commit") {
  assert.match(f.budgetRef, /^[a-f0-9]{64}$/);
  await f.observer.query(`create function abby_budget_fault() returns trigger language plpgsql as $$
    begin
      if NEW.budget_ref = TG_ARGV[0] then
        raise exception 'synthetic budget transaction failure';
      end if;
      return NEW;
    end $$`);
  const timing = mode === "statement" ? "create trigger abby_budget_fault before update" :
    "create constraint trigger abby_budget_fault after insert or update";
  const deferred = mode === "commit" ? " deferrable initially deferred" : "";
  await f.observer.query(`${timing} on cliniko_request_budgets${deferred}
    for each row execute function abby_budget_fault('${f.budgetRef}')`);
}

test("R24 early budget denial leaves no transaction for the next borrower", options, async () => fixture(async f => {
  const owner = budget(f);
  assert.equal(await owner.claim(), null);
  assert.equal((await owner.claim())?.kind, "rateLimited");
  assert.deepEqual(f.events, ["claimRateLimited"]);
  const row = (await f.observer.query<{ sent_at_ms: unknown[] }>(
    "select sent_at_ms from cliniko_request_budgets where budget_ref=$1", [f.budgetRef])).rows[0]!;
  assert.equal(row.sent_at_ms.length, 1);
  await nextBorrower(f);
}));

test("R24 application throw rolls budget work back before pool reuse", options, async () => fixture(async f => {
  const owner = budget(f); assert.equal(await owner.claim(), null);
  // PostgreSQL accepts this bigint; the application must reject its unsafe JS clock.
  await f.observer.query("update cliniko_request_budgets set sent_at_ms=$2::jsonb where budget_ref=$1",
    [f.budgetRef, JSON.stringify([Number.MAX_SAFE_INTEGER + 1])]);
  const lease = randomUUID();
  await f.observer.query("insert into cliniko_request_reservations(lease_ref,budget_ref,remaining,expires_at_ms) values($1,$2,1,1)",
    [lease, f.budgetRef]);
  assert.deepEqual(await owner.claim(), { kind: "unavailable" });
  assert.deepEqual(f.events, ["claimUnavailable"]);
  assert.equal((await f.observer.query("select lease_ref from cliniko_request_reservations where lease_ref=$1", [lease])).rowCount, 1,
    "the failed owner cannot commit expired-hold cleanup ahead of its application exception");
  await nextBorrower(f);
}));

for (const mode of ["statement", "commit"] as const) test(
  `R24 failed ${mode} cannot acknowledge budget work or contaminate the next borrower`, options, async () => fixture(async f => {
    await installFailure(f, mode);
    assert.deepEqual(await budget(f).claim(), { kind: "unavailable" });
    assert.deepEqual(f.events, ["claimUnavailable"], "diagnostics retain only the fixed failure classification");
    assert.equal((await f.observer.query("select budget_ref from cliniko_request_budgets where budget_ref=$1", [f.budgetRef])).rowCount, 0,
      "neither a failed statement nor a deferred commit failure may leave the newly created budget row committed");
    await nextBorrower(f);
  }));

test("R24 a caller-owned transaction cannot silently grant an uncommitted budget claim", options, async () => fixture(async f => {
  const id = randomUUID(), rollback = new Error("synthetic caller-owned rollback");
  await assert.rejects(f.db.transaction().execute(async outer => {
    await sql`insert into abby_tx_probe (id) values (${id}::uuid)`.execute(outer);
    assert.deepEqual(await budget(f, outer).claim(), { kind: "unavailable" });
    assert.equal((await sql`select id from abby_tx_probe where id=${id}::uuid`.execute(outer)).rows.length, 1,
      "denied nested work must leave the caller's own transaction usable");
    assert.equal((await f.observer.query("select id from abby_tx_probe where id=$1", [id])).rowCount, 0,
      "the budget must not commit its caller's unrelated work");
    throw rollback;
  }), error => error === rollback);
  assert.deepEqual(f.events, ["claimUnavailable"]);
  assert.equal((await f.observer.query("select id from abby_tx_probe where id=$1", [id])).rowCount, 0);
  assert.equal((await f.observer.query("select budget_ref from cliniko_request_budgets where budget_ref=$1", [f.budgetRef])).rowCount, 0);
  await nextBorrower(f);
}));
