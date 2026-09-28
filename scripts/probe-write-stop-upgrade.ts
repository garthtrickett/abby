import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { sql } from "kysely";
import { ok } from "../src/core/model.ts";
import type { Result } from "../src/core/model.ts";
import { connectPostgres } from "../src/storage/connect.ts";
import { migrate, migrateTo } from "../src/storage/migrate.ts";
import { PostgresLedger } from "../src/storage/postgres-ledger.ts";

function value<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`write-stop upgrade probe failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl || process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1") throw new Error("isolated PostgreSQL probe required");
const name = `abby_stop_upgrade_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: baseUrl });
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const db = connectPostgres(url.toString());
  try {
    await migrateTo(db, "005_clinic_write_stop");
    const scope = { tenantId: "stop-upgrade-tenant", clinicId: "stop-upgrade-clinic", locationId: "stop-upgrade-location" };
    await sql`insert into clinic_write_stop (tenant_id, clinic_id, stopped, actor_ref, reason, stopped_at)
      values (${scope.tenantId}, ${scope.clinicId}, true, 'first-admin', 'Original incident', '2026-09-28T10:00:00.000Z')`.execute(db);
    await sql`insert into clinic_write_stop_inflight (tenant_id, clinic_id, effect_id, call_id, action_key, status)
      values (${scope.tenantId}, ${scope.clinicId}, 'first-effect', 'first-call', 'first-action', 'possiblySent')`.execute(db);
    await migrate(db);
    const ledger = new PostgresLedger(db, undefined, async () => ok(true));
    const preserved = value(await ledger.readWriteStop(scope));
    assert.equal(preserved.version, "1");
    assert.equal(preserved.stopped, true);
    assert.deepEqual(preserved.inFlight.map(item => item.actionKey), ["first-action"]);
    assert.deepEqual(value(await ledger.listWriteStopChanges(scope)).entries.map(item => [item.version, item.stopped]), [["1", true]]);
    const resumed = value(await ledger.resumeWrites(scope, "1", "second-admin", "Recovered"));
    assert.deepEqual([resumed.version, resumed.stopped], ["2", false]);
    const stoppedAgain = value(await ledger.stopWrites(scope, "third-admin", "Second incident"));
    assert.deepEqual([stoppedAgain.version, stoppedAgain.stopped], ["3", true]);
    assert.deepEqual(value(await ledger.listWriteStopChanges(scope)).entries.map(item => [item.version, item.stopped]),
      [["1", true], ["2", false], ["3", true]]);
    const oldSnapshot = await sql<{ stop_version: number; action_key: string }>`select stop_version, action_key
      from clinic_write_stop_inflight where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId}`.execute(db);
    assert.deepEqual(oldSnapshot.rows, [{ stop_version: 1, action_key: "first-action" }]);
    console.log("v5 -> latest upgrade retained the stop audit and in-flight snapshot; resume and re-stop passed");
  } finally { await db.destroy(); }
} finally {
  try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
  finally { await admin.end(); }
}
