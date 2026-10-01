import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { after } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresOperationalCounters } from "../../src/storage/postgres-operational-counters.ts";
import { scanDisposableBackupCanaries } from "./backup-canary-scan.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = connectPostgres(url);
after(async () => { await db.destroy(); });

async function runWorker(tenantId: string): Promise<void> {
  const child = spawn(process.execPath, ["test/support/operational-counter-worker.ts", tenantId], {
    cwd: new URL("../../", import.meta.url), env: process.env,
    stdio: ["ignore", "ignore", "pipe"], signal: AbortSignal.timeout(20_000),
  });
  const errors: Buffer[] = [];
  child.stderr.on("data", chunk => errors.push(Buffer.from(chunk)));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, Buffer.concat(errors).toString("utf8"));
}

test("two worker processes atomically share scoped, patient-free operational totals", async () => {
  const tenantId = `ops-${randomUUID()}`;
  const scope = { tenantId, clinicId: "clinic", locationId: "main" };
  const counters = new PostgresOperationalCounters(db);
  await Promise.all([runWorker(tenantId), runWorker(tenantId)]);
  await counters.record(scope, "clinikoProviderUnavailable");
  assert.deepEqual(await counters.snapshot(scope), {
    admissionDenied: 80, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
    clinikoBudgetDenied: 0, clinikoBudgetUnavailable: 0, clinikoProvider429: 0,
    clinikoProviderUnavailable: 1,
  });
  const daily = await counters.daily(scope);
  assert.equal(daily.days.length, 7);
  assert.equal(daily.days.at(-1)?.counts.admissionDenied, 80);
  assert.equal(daily.days.at(-1)?.counts.clinikoProviderUnavailable, 1);
  assert.deepEqual(await counters.snapshot({ ...scope, locationId: "other" }), {
    admissionDenied: 0, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
    clinikoBudgetDenied: 0, clinikoBudgetUnavailable: 0, clinikoProvider429: 0,
    clinikoProviderUnavailable: 0,
  });
  assert.deepEqual(await counters.snapshot({ ...scope, clinicId: "other" }), {
    admissionDenied: 0, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
    clinikoBudgetDenied: 0, clinikoBudgetUnavailable: 0, clinikoProvider429: 0,
    clinikoProviderUnavailable: 0,
  });
  const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = 'clinic_operational_counts'
    order by ordinal_position`.execute(db);
  assert.deepEqual(columns.rows.map(row => row.column_name),
    ["tenant_id", "clinic_id", "location_id", "kind", "count"]);
  const dailyColumns = await sql<{ column_name: string }>`select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = 'clinic_operational_daily_counts'
    order by ordinal_position`.execute(db);
  assert.deepEqual(dailyColumns.rows.map(row => row.column_name),
    ["tenant_id", "clinic_id", "location_id", "date", "kind", "count"]);
  const canary = `patient-private-ops-${randomUUID()}`;
  const probes = [{ label: "patient", value: canary }];
  assert.deepEqual(await scanPatientDataCanaries(db, probes), { ok: true, value: [] });
  assert.deepEqual(await scanDisposableBackupCanaries(url, probes), []);
});

test("E2E-218 daily aggregates roll over in UTC, isolate reads and prune idle clinics globally", async () => {
  const scope = { tenantId: `ops-days-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
  const other = { ...scope, tenantId: `ops-days-other-${randomUUID()}` };
  let now = "2026-09-30T23:59:59.000Z";
  const counters = new PostgresOperationalCounters(db, () => now);
  await counters.record(scope, "clinikoProvider429");
  await counters.record(other, "clinikoProvider429");
  now = "2026-10-01T00:00:01.000Z";
  await counters.record(scope, "clinikoProviderUnavailable");
  const daily = await counters.daily(scope);
  assert.deepEqual(daily.days.slice(-2).map(row => [row.date, row.counts.clinikoProvider429,
    row.counts.clinikoProviderUnavailable]), [
    ["2026-09-30", 1, 0], ["2026-10-01", 0, 1],
  ]);
  assert.equal((await counters.daily({ ...scope, clinicId: "other" })).days.at(-1)?.counts.clinikoProviderUnavailable, 0);
  now = "2026-10-07T00:00:00.000Z";
  const later = await counters.daily(scope);
  assert.equal(later.days[0]?.date, "2026-10-01");
  assert.equal(later.days[0]?.counts.clinikoProviderUnavailable, 1);
  const older = await sql<{ count: string }>`select count(*)::text as count from clinic_operational_daily_counts
    where tenant_id = ${scope.tenantId} and date < date '2026-10-01'`.execute(db);
  assert.equal(older.rows[0]?.count, "0");
  const otherScope = await sql<{ count: string }>`select count(*)::text as count from clinic_operational_daily_counts
    where tenant_id = ${other.tenantId} and date = date '2026-09-30'`.execute(db);
  assert.equal(otherScope.rows[0]?.count, "1", "reading one clinic cannot delete another clinic's counters");
  await counters.pruneExpired();
  const prunedOther = await sql<{ count: string }>`select count(*)::text as count from clinic_operational_daily_counts
    where tenant_id = ${other.tenantId} and date = date '2026-09-30'`.execute(db);
  assert.equal(prunedOther.rows[0]?.count, "0", "global retention clears an idle clinic");
  assert.equal((await counters.snapshot(scope)).clinikoProvider429, 1);
});

test("E2E-218 one-shot retention command deletes expired rows without revealing scope", async () => {
  const tenantId = `ops-retention-${randomUUID()}`;
  await sql`insert into clinic_operational_daily_counts
    (tenant_id, clinic_id, location_id, date, kind, count)
    values (${tenantId}, 'clinic', 'main', date '2020-01-01', 'voiceFailure', 1)`.execute(db);
  const run = spawnSync(process.execPath, ["scripts/prune-voice-operations.ts"], {
    cwd: new URL("../../", import.meta.url), env: process.env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(run.stderr, "");
  const left = await sql<{ count: string }>`select count(*)::text as count from clinic_operational_daily_counts
    where tenant_id = ${tenantId}`.execute(db);
  assert.equal(left.rows[0]?.count, "0");
});
