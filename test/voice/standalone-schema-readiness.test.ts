// E2E-176: missing or incompatible shared budget storage cannot admit a new voice owner.
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import WebSocket from "ws";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { withStandaloneVoiceProfile } from "../support/standalone-voice-profile.ts";
import type { StandaloneProfileFixture } from "../support/standalone-voice-profile.ts";

type Db = StandaloneProfileFixture["db"];
const changes = [
  { name: "missingBudgetTable", apply: (db: Db) => sql`alter table cliniko_request_budgets rename to cliniko_request_budgets_unavailable`.execute(db) },
  { name: "incompatibleBudgetColumn", apply: (db: Db) => sql`alter table cliniko_request_budgets rename column sent_at_ms to legacy_sent_at_ms`.execute(db) },
  { name: "missingReservations", apply: (db: Db) => sql`alter table cliniko_request_reservations rename to cliniko_request_reservations_unavailable`.execute(db) },
  { name: "incompatibleReservationType", apply: (db: Db) => sql`alter table cliniko_request_reservations alter column remaining type bigint`.execute(db) },
  { name: "changedDefault", apply: (db: Db) => sql`alter table cliniko_request_budgets alter column sent_at_ms set default '[0]'::jsonb`.execute(db) },
  { name: "missingReservationPrimaryKey", apply: (db: Db) => sql`alter table cliniko_request_reservations drop constraint cliniko_request_reservations_pkey`.execute(db) },
  { name: "missingBounds", apply: (db: Db) => sql`alter table cliniko_request_reservations drop constraint cliniko_request_reservations_bounds`.execute(db) },
  { name: "disabledHoldGuard", apply: (db: Db) => sql`alter table cliniko_request_budgets disable trigger cliniko_request_budget_hold_guard`.execute(db) },
  { name: "changedHoldGuard", apply: (db: Db) => sql`create or replace function cliniko_request_budget_hold_guard() returns trigger language plpgsql as $$begin return new; end$$`.execute(db) },
] as const;

async function ready(app: StandaloneProfileFixture) {
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "0", "locale", "en-AU", "synthetic-owner")).ok);
  assert.ok((await app.policy.changeVoiceSetting(app.scope, "1", "voiceId", "coral", "synthetic-owner")).ok);
}

for (const drift of changes)
test(`running standalone voice refuses new signed admission after required schema drift: ${drift.name}`,
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => withStandaloneVoiceProfile(async app => {
    await ready(app);
    const original = await app.openCall(); assert.equal(original.ready, true); await original.close();
    await drift.apply(app.db);
    assert.equal((await sql<{ ready: number }>`select 1 as ready`.execute(app.db)).rows[0]!.ready, 1);
    const before = [app.requests.length, app.providers.length, app.reads()];
    const { response } = await app.requestCall(); assert.equal(response.status, 503);
    const body = await response.text(); assert.equal(body, "Unavailable");
    assert.doesNotMatch(body, /<Connect>|abbyBinding/);
    assert.deepEqual([app.requests.length, app.providers.length, app.reads()], before);
  }));

test("standalone stream attachment rechecks budget schema after an earlier valid signed webhook",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => withStandaloneVoiceProfile(async app => {
    await ready(app);
    const request = await app.requestCall(); assert.equal(request.response.status, 200);
    await sql`alter table cliniko_request_budgets rename to cliniko_request_budgets_unavailable`.execute(app.db);
    const call = await app.attachCall(request); assert.equal(call.ready, false); await call.close();
    assert.equal(app.requests.length, 0); assert.equal(app.providers.length, 0); assert.equal(app.reads(), 0);
  }));

test("repair permits only a fresh new call while schema refusal leaves the active call connected",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => withStandaloneVoiceProfile(async app => {
    await ready(app); const original = await app.openCall(); assert.equal(original.ready, true);
    await sql`alter table cliniko_request_budgets rename to cliniko_request_budgets_unavailable`.execute(app.db);
    const denied = await app.requestCall(); assert.equal(denied.response.status, 503); await denied.response.body?.cancel();
    assert.equal(original.socket.readyState, WebSocket.OPEN);
    await sql`alter table cliniko_request_budgets_unavailable rename to cliniko_request_budgets`.execute(app.db);
    const fresh = await app.openCall(); assert.equal(fresh.ready, true); await fresh.close(); await original.close();
  }));

test("budget schema inspection preserves every account and reservation row without spending quota",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => withStandaloneVoiceProfile(async app => {
    const budget = new PostgresClinikoRequestBudget(app.db, { apiKey: "synthetic-key-au5", maxPerMinute: 180 });
    assert.equal(await budget.claim(), null);
    const held = await budget.withReservation(2, new AbortController().signal, async () => {
      const read = async () => ({ accounts: await app.db.selectFrom("cliniko_request_budgets").selectAll().execute(),
        reservations: await app.db.selectFrom("cliniko_request_reservations").selectAll().execute() });
      const before = await read(); assert.equal(before.accounts.length, 1); assert.equal(before.reservations.length, 1);
      assert.equal(await budget.schemaCompatible(), true); assert.deepEqual(await read(), before);
    });
    assert.equal(held.kind, "completed");
  }));

test("concurrent signed admissions share a bounded stalled schema probe and remain unavailable",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 90_000 }, async () => {
    const original = PostgresClinikoRequestBudget.prototype.schemaCompatible;
    let stalled = false, probes = 0, settle!: (ready: boolean) => void;
    const pending = new Promise<boolean>(resolve => { settle = resolve; });
    PostgresClinikoRequestBudget.prototype.schemaCompatible = function (this: PostgresClinikoRequestBudget) {
      if (!stalled) return original.call(this); probes++; return pending;
    };
    try {
      await withStandaloneVoiceProfile(async app => {
        await ready(app); stalled = true; const began = performance.now();
        const results = await Promise.all([app.requestCall(), app.requestCall()]);
        assert.ok(performance.now() - began < 3500); assert.equal(probes, 1);
        for (const { response } of results) { assert.equal(response.status, 503); assert.equal(await response.text(), "Unavailable"); }
        assert.equal(app.requests.length, 0); assert.equal(app.providers.length, 0); assert.equal(app.reads(), 0);
        settle(false);
      });
    } finally { settle(false); PostgresClinikoRequestBudget.prototype.schemaCompatible = original; }
  });
