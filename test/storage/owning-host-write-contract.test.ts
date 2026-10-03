import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

type Request = { operation: "book" | "cancel" | "move"; tenant: string; attempt: string;
  appointment: string; patient: string; practitioner: string; business: string; service: string;
  revision: number | null; start: string | null; end: string | null };
type Outcome = { kind: "committed" | "targetChanged" | "slotUnavailable" | "requestMismatch" | "invalidRequest";
  operation?: string; appointment?: { appointment_id: string; revision: number; active: boolean; starts_at: string } };
const start = "2026-10-08T10:00:00Z", end = "2026-10-08T10:30:00Z";
function request(override: Partial<Request> = {}): Request {
  return { operation: "book", tenant: randomUUID(), attempt: randomUUID(), appointment: randomUUID(),
    patient: randomUUID(), practitioner: randomUUID(), business: randomUUID(), service: randomUUID(),
    revision: null, start, end, ...override };
}
async function commit(client: pg.Client, input: Request): Promise<Outcome> {
  const result = await client.query<{ outcome: Outcome }>(
    "select commit_diary($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as outcome",
    [input.operation, input.tenant, input.attempt, input.appointment, input.patient, input.practitioner,
      input.business, input.service, input.revision, input.start, input.end]);
  return result.rows[0]!.outcome;
}
function change(input: Request, operation: "cancel" | "move", override: Partial<Request> = {}): Request {
  return { ...input, operation, attempt: randomUUID(), revision: 1,
    start: operation === "cancel" ? null : "2026-10-08T11:00:00Z",
    end: operation === "cancel" ? null : "2026-10-08T11:30:00Z", ...override };
}
async function blocked(observer: pg.Client, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const row = (await observer.query<{ blocked: boolean }>(
      "select cardinality(pg_blocking_pids($1)) > 0 as blocked", [pid])).rows[0]!;
    if (row.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("second independent backend never waited on the competing transaction");
}

test("E2E-265 owning-host native diary commits protect intervals, targets and receipts",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 30_000 }, async t => {
  assert.ok(process.env.DATABASE_URL);
  const schema = `host_proof_${randomUUID().replaceAll("-", "")}`;
  const clients = [0, 1, 2].map(() => new pg.Client({ connectionString: process.env.DATABASE_URL }));
  const [a, b, observer] = clients as [pg.Client, pg.Client, pg.Client];
  try {
    await Promise.all(clients.map(client => client.connect()));
    await a.query("create extension if not exists btree_gist");
    await a.query(`create schema ${schema}`);
    for (const client of clients) {
      await client.query(`set search_path to ${schema}, public`);
      await client.query("set statement_timeout to '5s'");
    }
    await a.query(await readFile(new URL("../support/owning-host-diary.sql", import.meta.url), "utf8"));
    const pids = await Promise.all(clients.map(async client =>
      (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid));
    assert.equal(new Set(pids).size, 3);
    async function compete(first: Request, second: Request): Promise<[Outcome, Outcome]> {
      await a.query("begin");
      const winner = await commit(a, first);
      const waiting = commit(b, second).then(value => ({ value }), error => ({ error }));
      try { await blocked(observer, pids[1]!); }
      finally { await a.query("commit"); }
      const settled = await waiting;
      if ("error" in settled) throw settled.error;
      return [winner, settled.value];
    }

    await t.test("E2E-265 overlapping bookings across businesses serialize at the database", async () => {
      const first = request(), second = request({ tenant: first.tenant, practitioner: first.practitioner,
        start: "2026-10-08T10:15:00Z", end: "2026-10-08T10:45:00Z" });
      const outcomes = await compete(first, second);
      assert.deepEqual(outcomes.map(value => value.kind), ["committed", "slotUnavailable"]);
      const count = await observer.query<{ count: string }>("select count(*) from diary where tenant_id=$1", [first.tenant]);
      assert.equal(count.rows[0]!.count, "1");
    });
    await t.test("E2E-265 adjacent intervals and separate practitioners or tenants remain valid", async () => {
      const first = request(); assert.equal((await commit(a, first)).kind, "committed");
      for (const override of [{ start: end, end: "2026-10-08T11:00:00Z" },
        { practitioner: randomUUID() }, { tenant: randomUUID() }]) {
        assert.equal((await commit(b, request({ tenant: first.tenant, practitioner: first.practitioner, ...override }))).kind, "committed");
      }
      const sameInstant = request({ tenant: first.tenant, practitioner: first.practitioner,
        start: "2026-10-08T20:00:00+10:00", end: "2026-10-08T20:30:00+10:00" });
      assert.equal((await commit(b, sameInstant)).kind, "slotUnavailable");
    });
    await t.test("E2E-265 invalid empty, reversed, absent and infinite intervals are refused", async () => {
      for (const override of [{ end: start }, { start: end, end: start }, { start: null }, { end: "infinity" }]) {
        const input = request(override);
        assert.equal((await commit(a, input)).kind, "invalidRequest");
        assert.equal((await observer.query("select * from receipts where tenant_id=$1", [input.tenant])).rowCount, 0);
      }
    });
    await t.test("E2E-265 direct native inserts cannot bypass interval protection", async () => {
      const input = request(); assert.equal((await commit(a, input)).kind, "committed");
      await assert.rejects(b.query("insert into diary select tenant_id,$1,patient_id,practitioner_id,business_id,type_id,starts_at,ends_at,true,1 from diary where tenant_id=$2",
        [randomUUID(), input.tenant]), (error: unknown) => error instanceof Error && "code" in error && error.code === "23P01");
    });
    await t.test("E2E-265 native writers cannot delete, truncate or rename a confirmed identity", async () => {
      const input = request(); await commit(a, input);
      for (const statement of ["delete from diary where tenant_id=$1",
        "update diary set appointment_id=gen_random_uuid() where tenant_id=$1"]) {
        await assert.rejects(b.query(statement, [input.tenant]),
          (error: unknown) => error instanceof Error && "code" in error && error.code === "23514");
      }
      await assert.rejects(b.query("truncate diary"),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "23514");
      assert.equal((await observer.query("select * from diary where tenant_id=$1", [input.tenant])).rowCount, 1);
    });
    await t.test("E2E-265 stale cancellation loses to an independent native edit", async () => {
      const input = request(); await commit(a, input);
      await a.query("begin");
      await a.query("update diary set starts_at='2026-10-09T10:00:00Z',ends_at='2026-10-09T10:30:00Z' where tenant_id=$1", [input.tenant]);
      const waiting = commit(b, change(input, "cancel")).then(value => ({ value }), error => ({ error }));
      try { await blocked(observer, pids[1]!); } finally { await a.query("commit"); }
      const settled = await waiting; if ("error" in settled) throw settled.error;
      assert.equal(settled.value.kind, "targetChanged");
      const row = (await observer.query<{ active: boolean; revision: string }>("select active,revision from diary where tenant_id=$1", [input.tenant])).rows[0]!;
      assert.equal(row.active, true); assert.equal(row.revision, "2");
    });
    await t.test("E2E-265 cancellation and move of one confirmed version cannot both commit", async () => {
      const input = request(); await commit(a, input);
      assert.deepEqual((await compete(change(input, "cancel"), change(input, "move"))).map(value => value.kind),
        ["committed", "targetChanged"]);
    });
    await t.test("E2E-265 competing moves commit once and preserve the losing source interval", async () => {
      const first = request(), second = request({ tenant: first.tenant, practitioner: first.practitioner,
        start: "2026-10-08T12:00:00Z", end: "2026-10-08T12:30:00Z" });
      await commit(a, first); await commit(b, second);
      assert.deepEqual((await compete(change(first, "move"), change(second, "move"))).map(value => value.kind),
        ["committed", "slotUnavailable"]);
      const row = (await observer.query<{ starts_at: Date; revision: string }>(
        "select starts_at,revision from diary where tenant_id=$1 and appointment_id=$2", [second.tenant, second.appointment])).rows[0]!;
      assert.equal(row.starts_at.toISOString(), "2026-10-08T12:00:00.000Z"); assert.equal(row.revision, "1");
    });
    await t.test("E2E-265 a competing booking prevents a move without releasing its old slot", async () => {
      const input = request(); await commit(a, input);
      const move = change(input, "move");
      const booking = request({ tenant: input.tenant, practitioner: input.practitioner, start: move.start, end: move.end });
      assert.deepEqual((await compete(booking, move)).map(value => value.kind), ["committed", "slotUnavailable"]);
      const row = (await observer.query<{ starts_at: Date; revision: string }>(
        "select starts_at,revision from diary where tenant_id=$1 and appointment_id=$2", [input.tenant, input.appointment])).rows[0]!;
      assert.equal(row.starts_at.toISOString(), "2026-10-08T10:00:00.000Z"); assert.equal(row.revision, "1");
    });
    await t.test("E2E-265 wrong patient, business, practitioner, service and tenant cannot cancel a target", async () => {
      const input = request(); await commit(a, input);
      for (const key of ["patient", "business", "practitioner", "service", "tenant"] as const) {
        assert.equal((await commit(b, change(input, "cancel", { [key]: randomUUID() }))).kind, "targetChanged");
      }
      assert.equal((await observer.query<{ active: boolean }>(
        "select active from diary where tenant_id=$1", [input.tenant])).rows[0]!.active, true);
    });
    await t.test("E2E-265 identical attempts share one receipt and changed payload cannot reuse it", async () => {
      const input = request(); const outcomes = await compete(input, input);
      assert.deepEqual(outcomes[0], outcomes[1]);
      assert.equal((await commit(b, { ...input, patient: randomUUID() })).kind, "requestMismatch");
      assert.equal((await observer.query("select * from diary where tenant_id=$1", [input.tenant])).rowCount, 1);
      assert.equal((await observer.query("select * from receipts where tenant_id=$1", [input.tenant])).rowCount, 1);
    });
    await t.test("E2E-265 rollback discards both mutation and receipt", async () => {
      const input = request(); await a.query("begin"); await commit(a, input); await a.query("rollback");
      assert.equal((await observer.query("select * from diary where tenant_id=$1", [input.tenant])).rowCount, 0);
      assert.equal((await observer.query("select * from receipts where tenant_id=$1", [input.tenant])).rowCount, 0);
    });
    await t.test("E2E-265 a fresh owner reads the exact committed receipt without issuing a mutation", async () => {
      const input = request(); const outcome = await commit(a, input);
      // Deliberately discard the result at the caller; this is not a TCP-loss claim.
      const recovered = (await observer.query<{ result: Outcome }>(
        "select result from receipts where tenant_id=$1 and attempt_id=$2", [input.tenant, input.attempt])).rows[0]!.result;
      assert.deepEqual(recovered, outcome);
      assert.equal((await observer.query("select * from receipts where tenant_id=$1", [randomUUID()])).rowCount, 0);
    });
  } finally {
    await a.query("rollback").catch(() => {});
    await b.query("rollback").catch(() => {});
    await a.query(`drop schema if exists ${schema} cascade`).catch(() => {});
    await Promise.all(clients.map(client => client.end()));
  }
});
