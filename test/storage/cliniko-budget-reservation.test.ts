import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import test, { after } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { withClinikoReservation } from "../../src/cliniko/read-budget.ts";
import type { ClinikoRequestBudgetsBudgetRef } from "../../src/storage/generated/public/ClinikoRequestBudgets.ts";

const url = process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL is required");
const firstDb = connectPostgres(url), secondDb = connectPostgres(url);
after(async () => { await Promise.all([firstDb.destroy(), secondDb.destroy()]); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const key = () => `synthetic-allocation-${randomUUID()}-au5`;
const ref = (value: string) => createHash("sha256").update(`abby-cliniko-budget-v1\0${value}`).digest("hex") as ClinikoRequestBudgetsBudgetRef;

async function legacyClaim(apiKey: string): Promise<boolean> {
  const child = fork(new URL("../support/legacy-cliniko-budget-worker.ts", import.meta.url), [], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, ABBY_SYNTHETIC_BUDGET_KEY: apiKey },
  });
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(5_000) }) as [Record<string, unknown>];
    assert.equal(message.kind, "legacyClaim"); assert.equal(typeof message.accepted, "boolean");
    return message.accepted as boolean;
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } }
}

test("E2E-416 a separate process cannot spend requests held by a live owner", async () => {
  const apiKey = key(), outsider = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 4 });
  const child = fork(new URL("../support/cliniko-budget-allocation-worker.ts", import.meta.url), [], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, ABBY_SYNTHETIC_BUDGET_KEY: apiKey },
  });
  const messages: Record<string, unknown>[] = []; let errors = "";
  child.on("message", m => { if (m && typeof m === "object") messages.push(m as Record<string, unknown>); });
  child.stderr?.on("data", b => { errors += String(b); });
  const until = async (kind: string) => {
    const stop = Date.now() + 5000;
    while (!messages.some(m => m.kind === kind) && child.exitCode === null && Date.now() < stop) await new Promise(r => setTimeout(r, 5));
    assert.ok(messages.some(m => m.kind === kind), `worker ${kind}: ${errors}`);
  };
  try {
    await until("held"); assert.equal((await outsider.claim())?.kind, "rateLimited");
    assert.equal((await outsider.checkHeadroom(1))?.kind, "rateLimited");
    assert.equal((await outsider.withReservation(1, new AbortController().signal, async () => assert.fail("over-reserved"))).kind, "denied");
    const held = await firstDb.selectFrom("cliniko_request_reservations").selectAll().where("budget_ref", "=", ref(apiKey)).execute();
    assert.equal(held.length, 1); assert.deepEqual(Object.keys(held[0]!).sort(), ["budget_ref", "expires_at_ms", "lease_ref", "remaining"]);
    assert.equal(held[0]!.remaining, 4); assert.equal(JSON.stringify(held).includes(apiKey), false);
    child.send({ kind: "finish" }); await until("done");
    assert.equal(messages.find(m => m.kind === "ownerClaims")!.accepted, 2); assert.equal(messages.find(m => m.kind === "done")!.outcome, "completed");
    assert.equal(await outsider.claim(), null); assert.equal(await outsider.claim(), null); assert.equal((await outsider.claim())?.kind, "rateLimited");
    assert.equal((await firstDb.selectFrom("cliniko_request_reservations").selectAll().where("budget_ref", "=", ref(apiKey)).execute()).length, 0);
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } }
});

test("E2E-416 a legacy process that ignores allocations cannot steal held capacity", async () => {
  const apiKey = key(), owner = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 4 });
  let accepted: boolean | undefined;
  const result = await owner.withReservation(4, new AbortController().signal, async () => {
    // Expired physical sends do not occupy capacity, even on a legacy row that
    // has not yet pruned its timestamp array. The trigger must count live sends.
    await sql`update cliniko_request_budgets set sent_at_ms = jsonb_build_array(
      floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 60001)
      where budget_ref = ${ref(apiKey)}`.execute(firstDb);
    accepted = await legacyClaim(apiKey);
    assert.equal(await owner.claim(), null);
  });
  assert.equal(accepted, false);
  assert.equal(result.kind, "completed");
});

test("E2E-416 legacy callers can use unallocated capacity without consuming the owner's balance", async () => {
  const apiKey = key(), owner = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 4 });
  const accepted: boolean[] = [];
  const result = await owner.withReservation(3, new AbortController().signal, async () => {
    accepted.push(await legacyClaim(apiKey), await legacyClaim(apiKey));
    assert.equal(await owner.claim(), null); assert.equal(await owner.claim(), null); assert.equal(await owner.claim(), null);
  });
  assert.deepEqual(accepted, [true, false]); assert.equal(result.kind, "completed");
  assert.equal((await owner.claim())?.kind, "rateLimited");
});

test("E2E-416 a killed owner releases its capacity through database expiry", { timeout: 45_000 }, async () => {
  const apiKey = key(), outsider = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 4 });
  const child = fork(new URL("../support/cliniko-budget-allocation-worker.ts", import.meta.url), [], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, ABBY_SYNTHETIC_BUDGET_KEY: apiKey },
  });
  try {
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(5_000) }) as [Record<string, unknown>];
    assert.equal(message.kind, "held");
    const row = await firstDb.selectFrom("cliniko_request_reservations").select(["remaining", "expires_at_ms"])
      .where("budget_ref", "=", ref(apiKey)).executeTakeFirstOrThrow();
    assert.equal(row.remaining, 4);
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    assert.equal((await outsider.claim())?.kind, "rateLimited");
    const wait = Number(row.expires_at_ms) - Date.now() + 50; assert.ok(wait > 0 && wait <= 30_050);
    await new Promise(resolve => setTimeout(resolve, wait));
    assert.equal(await outsider.checkHeadroom(4), null); assert.equal(await outsider.claim(), null);
    assert.equal((await firstDb.selectFrom("cliniko_request_reservations").selectAll().where("budget_ref", "=", ref(apiKey)).execute()).length, 0);
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } }
});

test("E2E-416 shared user grouping consumes one allocation across connections and credentials", async () => {
  const group = `synthetic-user-${randomUUID()}`;
  const first = new PostgresClinikoRequestBudget(firstDb, { apiKey: key(), sharedUserRef: group, maxPerMinute: 3 });
  const second = new PostgresClinikoRequestBudget(secondDb, { apiKey: key(), sharedUserRef: group, maxPerMinute: 3 });
  const unrelated = new PostgresClinikoRequestBudget(secondDb, { apiKey: key(), maxPerMinute: 3 });
  assert.equal((await withClinikoReservation(first, 2, new AbortController().signal, async () => {
    assert.equal(await second.claim(), null); assert.equal(await first.claim(), null);
    assert.deepEqual(await second.claim(), { kind: "unavailable" });
    assert.equal(await unrelated.claim(), null);
  })).kind, "completed");
  assert.equal(await second.claim(), null); assert.equal((await first.claim())?.kind, "rateLimited");
});

test("E2E-416 concurrent allocations cannot overbook the physical account", async () => {
  const apiKey = key(), first = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 4 }), second = new PostgresClinikoRequestBudget(secondDb, { apiKey, maxPerMinute: 4 });
  const ready = gate(), blocked = gate(), finish = gate(); let admitted = 0, denied = 0;
  const runs = Array.from({ length: 8 }, async (_, i) => {
    const result = await (i % 2 ? first : second).withReservation(2, new AbortController().signal, async () => {
    if (++admitted === 2) ready.resolve(); await finish.promise; assert.equal(await (i % 2 ? first : second).claim(), null); return i;
    });
    if (result.kind === "denied" && ++denied === 6) blocked.resolve(); return result;
  });
  await ready.promise; await blocked.promise;
  const rows = await firstDb.selectFrom("cliniko_request_reservations").selectAll().where("budget_ref", "=", ref(apiKey)).execute();
  assert.equal(rows.reduce((n, r) => n + r.remaining, 0), 4); assert.equal((await second.claim())?.kind, "rateLimited");
  finish.resolve(); const results = await Promise.all(runs);
  assert.equal(results.filter(r => r.kind === "completed").length, 2); assert.equal(results.filter(r => r.kind === "denied").length, 6);
});

test("E2E-416 expired SQL allocation never becomes an ordinary claim for its old owner", async () => {
  const apiKey = key(), owner = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 2 }), outsider = new PostgresClinikoRequestBudget(secondDb, { apiKey, maxPerMinute: 2 });
  const ready = gate(), finish = gate();
  const held = owner.withReservation(2, new AbortController().signal, async () => { ready.resolve(); await finish.promise; return owner.claim(); });
  await ready.promise;
  await sql`update cliniko_request_reservations set expires_at_ms = floor(extract(epoch from clock_timestamp()) * 1000)::bigint - 1 where budget_ref = ${ref(apiKey)}`.execute(secondDb);
  assert.equal(await outsider.claim(), null); finish.resolve();
  assert.deepEqual(await held, { kind: "completed", value: { kind: "unavailable" } }); assert.equal(await outsider.claim(), null);
});

test("E2E-416 aborted or failed callbacks release only unused capacity and remain potentially sent", async () => {
  for (const mode of ["abort", "throw"] as const) {
    const apiKey = key(), owner = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 3 }), outsider = new PostgresClinikoRequestBudget(secondDb, { apiKey, maxPerMinute: 3 });
    const ready = gate(), finish = gate(), lifetime = new AbortController(); let escaped: Promise<unknown> | undefined;
    const held = owner.withReservation(3, lifetime.signal, async () => {
      assert.equal(await owner.claim(), null); ready.resolve();
      if (mode === "throw") throw new Error("possibly sent");
      escaped = (async () => { await finish.promise; return owner.claim(); })(); await finish.promise; return "late";
    });
    await ready.promise; if (mode === "abort") lifetime.abort(); assert.deepEqual(await held, { kind: "interrupted" });
    assert.equal(await outsider.claim(), null); assert.equal(await outsider.claim(), null); assert.equal((await outsider.claim())?.kind, "rateLimited");
    finish.resolve(); if (escaped) assert.deepEqual(await escaped, { kind: "unavailable" });
  }
});

test("E2E-416 cooldown and configured-limit conflicts fence held capacity", async () => {
  const apiKey = key(), owner = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 3 }), second = new PostgresClinikoRequestBudget(secondDb, { apiKey, maxPerMinute: 3 });
  const conflicting = new PostgresClinikoRequestBudget(secondDb, { apiKey, maxPerMinute: 4 });
  assert.equal((await owner.withReservation(2, new AbortController().signal, async () => {
    assert.deepEqual(await conflicting.claim(), { kind: "unavailable" });
    await second.observe429(null); assert.equal((await owner.claim())?.kind, "rateLimited");
  })).kind, "completed");
  assert.equal((await second.claim())?.kind, "rateLimited");
});

test("E2E-416 unavailable allocation storage cannot invoke a native task", async () => {
  const db = connectPostgres("postgresql://postgres@127.0.0.1:1/unavailable");
  try {
    const budget = new PostgresClinikoRequestBudget(db, { apiKey: key() }); let invoked = false;
    assert.deepEqual(await budget.withReservation(1, new AbortController().signal, async () => { invoked = true; }), { kind: "denied", denial: { kind: "unavailable" } });
    assert.equal(invoked, false);
  } finally { await db.destroy(); }
});

test("E2E-416 allocation migration preserves prior claims and refuses rollback over a live owner", async () => {
  const apiKey = key(), budget = new PostgresClinikoRequestBudget(firstDb, { apiKey, maxPerMinute: 3 });
  assert.equal(await budget.claim(), null);
  await migrateTo(firstDb, "047_confirmation_resend_journal");
  assert.deepEqual(await budget.claim(), { kind: "unavailable" });
  await migrate(firstDb); assert.equal(await budget.checkHeadroom(2), null);
  assert.equal((await budget.withReservation(2, new AbortController().signal, async () => {
    await assert.rejects(migrateTo(secondDb, "047_confirmation_resend_journal"), /active Cliniko allocations/);
    assert.equal(await budget.claim(), null);
  })).kind, "completed");
  assert.equal(await budget.claim(), null); assert.equal((await budget.claim())?.kind, "rateLimited");
});
