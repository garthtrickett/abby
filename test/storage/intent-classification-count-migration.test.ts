import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresOperationalCounters } from "../../src/storage/postgres-operational-counters.ts";

test("E2E-237 classifier count migration refuses a downgrade that would discard aggregate evidence",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1" }, async () => {
    const adminUrl = process.env.DATABASE_URL;
    assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl);
    const databaseName = `abby_test_intent_count_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl);
    target.pathname = `/${databaseName}`;
    let created = false;
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin);
      created = true;
      const db = connectPostgres(target.toString());
      try {
        await migrate(db);
        const scope = { tenantId: "intent-count", clinicId: "clinic", locationId: "main" };
        const counters = new PostgresOperationalCounters(db);
        await counters.record(scope, "intentClassificationUnavailable");
        assert.equal((await counters.snapshot(scope)).intentClassificationUnavailable, 1);
        assert.equal((await counters.daily(scope)).days.at(-1)?.counts.intentClassificationUnavailable, 1);
        const newer = await sql<{ name: string }>`select name from kysely_migration
          where name > '032_intent_classification_unavailable_count' order by name desc`.execute(db);
        for (const _ of newer.rows) await migrate(db, "down");
        await assert.rejects(migrate(db, "down"), /intent classification counts prevent downgrade/);
        assert.equal((await counters.snapshot(scope)).intentClassificationUnavailable, 1);
        await db.deleteFrom("clinic_operational_daily_counts").execute();
        await db.deleteFrom("clinic_operational_counts").execute();
        await migrate(db, "down");
        await assert.rejects(counters.record(scope, "intentClassificationUnavailable"));
        await migrate(db);
        await counters.record(scope, "intentClassificationUnavailable");
        assert.equal((await counters.snapshot(scope)).intentClassificationUnavailable, 1);
      } finally { await db.destroy(); }
    } finally {
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
