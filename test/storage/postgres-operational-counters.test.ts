import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { sql } from "kysely";
import { sendVoiceOperationalAlerts } from "../../scripts/send-voice-operational-alerts.ts";
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

test("E2E-237 two worker processes atomically share scoped, patient-free operational totals", async () => {
  const tenantId = `ops-${randomUUID()}`;
  const scope = { tenantId, clinicId: "clinic", locationId: "main" };
  const counters = new PostgresOperationalCounters(db);
  await Promise.all([runWorker(tenantId), runWorker(tenantId)]);
  await counters.record(scope, "clinikoProviderUnavailable");
  await counters.record(scope, "intentClassificationUnavailable");
  assert.deepEqual(await counters.snapshot(scope), {
    admissionDenied: 80, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
    clinikoBudgetDenied: 0, clinikoBudgetUnavailable: 0, clinikoProvider429: 0,
    clinikoProviderUnavailable: 1, intentClassificationUnavailable: 1,
  });
  const daily = await counters.daily(scope);
  assert.equal(daily.days.length, 7);
  assert.equal(daily.days.at(-1)?.counts.admissionDenied, 80);
  assert.equal(daily.days.at(-1)?.counts.clinikoProviderUnavailable, 1);
  assert.equal(daily.days.at(-1)?.counts.intentClassificationUnavailable, 1);
  assert.deepEqual(await counters.snapshot({ ...scope, locationId: "other" }), {
    admissionDenied: 0, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
    clinikoBudgetDenied: 0, clinikoBudgetUnavailable: 0, clinikoProvider429: 0,
    clinikoProviderUnavailable: 0, intentClassificationUnavailable: 0,
  });
  assert.deepEqual(await counters.snapshot({ ...scope, clinicId: "other" }), {
    admissionDenied: 0, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
    clinikoBudgetDenied: 0, clinikoBudgetUnavailable: 0, clinikoProvider429: 0,
    clinikoProviderUnavailable: 0, intentClassificationUnavailable: 0,
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

test("E2E-219 E2E-237 owner threshold command enables selected fixed codes and isolates its clinic", async () => {
  const tenantId = `ops-threshold-${randomUUID()}`;
  const otherTenantId = `ops-threshold-other-${randomUUID()}`;
  const today = new Date().toISOString().slice(0, 10);
  await sql`insert into clinic_operational_daily_counts
    (tenant_id, clinic_id, location_id, date, kind, count) values
    (${tenantId}, 'clinic', 'main', ${today}::date, 'clinikoProvider429', 2),
    (${tenantId}, 'clinic', 'main', ${today}::date, 'intentClassificationUnavailable', 1),
    (${tenantId}, 'clinic', 'main', ${today}::date, 'voiceFailure', 1),
    (${otherTenantId}, 'clinic', 'main', ${today}::date, 'clinikoProvider429', 99)`.execute(db);
  const env = { ...process.env, ABBY_TENANT_ID: tenantId, ABBY_CLINIC_ID: "clinic",
    ABBY_LOCATION_ID: "main", ABBY_VOICE_OPS_THRESHOLDS_JSON: '{"clinikoProvider429":2}' };
  const run = (thresholds: string) => spawnSync(process.execPath, ["scripts/check-voice-operations.ts"], {
    cwd: new URL("../../", import.meta.url), env: { ...env, ABBY_VOICE_OPS_THRESHOLDS_JSON: thresholds },
    encoding: "utf8", timeout: 10_000,
  });
  const crossed = run('{"clinikoProvider429":2}');
  assert.equal(crossed.status, 2, crossed.stderr);
  assert.equal(crossed.stderr, "");
  assert.deepEqual(JSON.parse(crossed.stdout), { date: today,
    alerts: [{ kind: "clinikoProvider429", count: 2, threshold: 2 }] });
  const classifierCrossed = run('{"intentClassificationUnavailable":1}');
  assert.equal(classifierCrossed.status, 2, classifierCrossed.stderr);
  assert.deepEqual(JSON.parse(classifierCrossed.stdout), { date: today,
    alerts: [{ kind: "intentClassificationUnavailable", count: 1, threshold: 1 }] });
  const clear = run('{"clinikoProvider429":3}');
  assert.equal(clear.status, 0, clear.stderr);
  assert.deepEqual(JSON.parse(clear.stdout), { date: today, alerts: [] });
  for (const invalid of ['{}', '{"patientPhone":"+61400123456"}', '{"clinikoProvider429":0}']) {
    const rejected = run(invalid);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.stderr, "operational threshold check unavailable\n");
  }
});

test("E2E-220 E2E-237 owner webhook accepts redacted classifier alerts and refuses redirects", async () => {
  const tenantId = `ops-alert-${randomUUID()}`;
  const otherTenantId = `ops-alert-other-${randomUUID()}`;
  const patientCanary = `patient-alert-${randomUUID()}`;
  const today = new Date().toISOString().slice(0, 10);
  await sql`insert into clinic_operational_daily_counts
    (tenant_id, clinic_id, location_id, date, kind, count) values
    (${tenantId}, 'clinic', 'main', ${today}::date, 'clinikoProvider429', 2),
    (${tenantId}, 'clinic', 'main', ${today}::date, 'intentClassificationUnavailable', 1),
    (${tenantId}, 'clinic', 'main', ${today}::date, 'voiceFailure', 1),
    (${otherTenantId}, 'clinic', 'main', ${today}::date, 'clinikoProvider429', 99)`.execute(db);
  const requests: { path: string; authorization: string; key: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization ?? "",
        key: String(request.headers["idempotency-key"] ?? ""), body });
      response.writeHead(request.url === "/redirect" ? 302 : request.url === "/fail" ? 503 : 202,
        request.url === "/redirect" ? { location: "/must-not-follow" } : {});
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const token = "a".repeat(64);
    const env = { ...process.env, ABBY_TENANT_ID: tenantId, ABBY_CLINIC_ID: "clinic",
      ABBY_LOCATION_ID: "main", ABBY_VOICE_OPS_THRESHOLDS_JSON: '{"clinikoProvider429":2}',
      ABBY_VOICE_ALERT_TOKEN_HEX: token, ABBY_VOICE_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/alerts`,
      ABBY_PATIENT_CANARY: patientCanary };
    const ports = { allowTestLoopbackHttp: true };
    assert.deepEqual(await sendVoiceOperationalAlerts(env, ports), { date: today, accepted: 1 });
    assert.deepEqual(await sendVoiceOperationalAlerts(env, ports), { date: today, accepted: 1 });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.authorization, `Bearer ${token}`);
    assert.match(requests[0]!.key, /^[a-f0-9]{64}$/);
    assert.equal(requests[0]?.key, requests[1]?.key, "retry uses a stable receiver deduplication key");
    assert.deepEqual(JSON.parse(requests[0]!.body), { schemaVersion: 1, date: today,
      kind: "clinikoProvider429", count: 2, threshold: 2, alertKey: requests[0]!.key });
    assert.equal(requests[0]!.body.includes(patientCanary), false);
    assert.equal(requests[0]!.body.includes(tenantId), false);
    assert.equal(requests[0]!.body.includes(otherTenantId), false);
    assert.deepEqual(await sendVoiceOperationalAlerts({ ...env,
      ABBY_VOICE_OPS_THRESHOLDS_JSON: '{"clinikoProvider429":3}' }, ports), { date: today, accepted: 0 });
    assert.equal(requests.length, 2, "clear threshold makes no network request");
    await assert.rejects(sendVoiceOperationalAlerts(env), /invalid operational alert destination/);
    await assert.rejects(sendVoiceOperationalAlerts({ ...env,
      ABBY_VOICE_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/redirect` }, ports),
      /operational alert delivery unavailable/);
    assert.equal(requests.length, 3);
    assert.equal(requests[2]?.path, "/redirect", "redirect target receives no bearer token");
    await assert.rejects(sendVoiceOperationalAlerts({ ...env,
      ABBY_VOICE_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/fail` }, ports),
      /operational alert delivery unavailable/);
    assert.equal(requests.length, 4, "a rejected webhook response is never reported as accepted");
    await assert.rejects(sendVoiceOperationalAlerts({ ...env,
      ABBY_VOICE_ALERT_WEBHOOK_URL: `https://example.invalid/alerts?patient=${patientCanary}` }),
      /invalid operational alert destination/);
    assert.equal(requests.length, 4);
    assert.deepEqual(await sendVoiceOperationalAlerts({ ...env,
      ABBY_VOICE_OPS_THRESHOLDS_JSON: '{"intentClassificationUnavailable":1}' }, ports),
    { date: today, accepted: 1 });
    assert.equal(requests.length, 5);
    assert.equal(JSON.parse(requests[4]!.body).kind, "intentClassificationUnavailable");
    assert.equal(requests[4]!.body.includes(patientCanary), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("E2E-220 scheduled webhook catches up retained days with stable per-day keys", async () => {
  const tenantId = `ops-catchup-${randomUUID()}`;
  const foreignTenantId = `ops-catchup-foreign-${randomUUID()}`;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  const expired = new Date(Date.parse(`${today}T00:00:00.000Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  await sql`insert into clinic_operational_daily_counts
    (tenant_id, clinic_id, location_id, date, kind, count) values
    (${tenantId}, 'clinic', 'main', ${yesterday}::date, 'voiceFailure', 3),
    (${tenantId}, 'clinic', 'main', ${today}::date, 'voiceFailure', 4),
    (${tenantId}, 'clinic', 'main', ${expired}::date, 'voiceFailure', 100),
    (${foreignTenantId}, 'clinic', 'main', ${yesterday}::date, 'voiceFailure', 99)`.execute(db);
  const requests: { key: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push({ key: String(request.headers["idempotency-key"] ?? ""), body });
      response.writeHead(202).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const env = { ...process.env, ABBY_TENANT_ID: tenantId, ABBY_CLINIC_ID: "clinic",
      ABBY_LOCATION_ID: "main", ABBY_VOICE_OPS_THRESHOLDS_JSON: '{"voiceFailure":2}',
      ABBY_VOICE_ALERT_TOKEN_HEX: "b".repeat(64),
      ABBY_VOICE_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/alerts` };
    assert.deepEqual(await sendVoiceOperationalAlerts(env, { allowTestLoopbackHttp: true }),
      { date: today, accepted: 2 });
    assert.deepEqual(await sendVoiceOperationalAlerts(env, { allowTestLoopbackHttp: true }),
      { date: today, accepted: 2 });
    assert.deepEqual(requests.map(request => JSON.parse(request.body).date),
      [yesterday, today, yesterday, today]);
    assert.deepEqual(requests.map(request => JSON.parse(request.body).count), [3, 4, 3, 4]);
    assert.equal(requests[0]?.key, requests[2]?.key);
    assert.equal(requests[1]?.key, requests[3]?.key);
    assert.notEqual(requests[0]?.key, requests[1]?.key);
    for (const request of requests) {
      assert.equal(JSON.parse(request.body).alertKey, request.key);
      assert.equal(request.body.includes(tenantId), false);
      assert.equal(request.body.includes(foreignTenantId), false);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
