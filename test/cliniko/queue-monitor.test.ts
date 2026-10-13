import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test, { describe } from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { ClinikoQueueMonitor, queueMonitorFingerprint } from "../../src/standalone/cliniko-queue-monitor.ts";
import type { QueueMonitorApproval } from "../../src/standalone/cliniko-queue-monitor.ts";
import { clinicQueueDate } from "../../src/standalone/cliniko-queue-pulse.ts";
import { clinikoCredentialFingerprint } from "../../src/cliniko/read-budget.ts";
import { OwnerFileAdminDirectory } from "../../src/standalone/identity/owner-file-admin-directory.ts";
import { VoiceOperationalAlertInbox } from "../../src/standalone/voice-operational-alert-inbox.ts";
import { startVoiceOperationalAlertReceiver } from "../../src/standalone/voice-operational-alert-receiver.ts";
import { parseThresholds, parseAggregateAlertThresholds } from "../../src/standalone/operational-alert.ts";
import { compiledRuntimeEntrypoint } from "../support/compiled-runtime-entrypoint.ts";

const options = { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 };
const patientCanary = "918273645546372", notesCanary = "private queue patient notes canary";
async function fixture(run: (f: Awaited<ReturnType<typeof create>>) => Promise<void>) {
  const url = process.env.DATABASE_URL; assert.ok(url); const admin = connectPostgres(url), name = `abby_test_queue_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(url); target.pathname = `/${name}`; let created = false, f: Awaited<ReturnType<typeof create>> | undefined;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try { await sql.raw(`create database "${name}"`).execute(admin); created = true; db = connectPostgres(target.toString()); await migrate(db); f = await create(db, target.toString()); await run(f); }
  finally { await f?.close(); await db?.destroy(); if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); await admin.destroy(); }
}
async function create(db: ReturnType<typeof connectPostgres>, databaseUrl: string) {
  const folder = await mkdtemp(join(tmpdir(), "abby-queue-monitor-")), inboxPath = join(folder, "inbox");
  await import("node:fs/promises").then(fs => fs.mkdir(inboxPath, { mode: 0o700 }));
  const scope = { tenantId: "queue-monitor", clinicId: "clinic", locationId: "main" }, apiKey = "synthetic-queue-au5", token = "c".repeat(64);
  const now = new Date().toISOString(), clock = () => now, typeId = "7", zone = "Australia/Sydney", day = clinicQueueDate(new Date(now), zone);
  const yesterday = new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  const accounts = [{ email: "admin@example.test", actor: { actorRef: "admin", role: "clinicAdmin", scope }, membershipVersion: "monitor-1" }];
  const adminPath = join(folder, "admins.json"), staffPath = join(folder, "staff.json"), monitorPath = join(folder, "monitor.json");
  const common = { scope, revision: "monitor-1", approverRef: "admin", approvedAt: new Date(Date.parse(now) - 86_400_000).toISOString(),
    effectiveFrom: new Date(Date.parse(now) - 86_400_000).toISOString(), effectiveUntil: new Date(Date.parse(now) + 86_400_000).toISOString(), approved: true, enabled: true,
    policyVersion: "1", businessId: "11", recallTypeId: typeId, credentialFingerprint: clinikoCredentialFingerprint(apiKey), timeZone: zone,
    reviewOwnerRef: "duty-owner", reviewBackupRef: "duty-backup" };
  await writeFile(adminPath, JSON.stringify(accounts), { mode: 0o600 });
  const staff = { ...common, reviewProcess: "clinikoRecallsFullType", reviewCadenceMinutes: 30, staffLabels: [] };
  await writeFile(staffPath, JSON.stringify(staff), { mode: 0o600 });
  const inbox = new VoiceOperationalAlertInbox({ scope, tokenHex: token, directory: inboxPath, clock,
    thresholds: { clinikoQueuePending: 1, clinikoQueueOverdue: 1, clinikoQueueUnavailable: 1 } });
  const receiver = await startVoiceOperationalAlertReceiver(inbox), destination = `http://127.0.0.1:${receiver.port}/voice-operational-alerts`;
  const approval: QueueMonitorApproval = { ...common, pendingThreshold: 1, overdueThreshold: 1, alertUnavailable: true, pollEveryMinutes: 15,
    destinationFingerprint: queueMonitorFingerprint(destination), alertTokenFingerprint: queueMonitorFingerprint(token) };
  await writeFile(monitorPath, JSON.stringify(approval), { mode: 0o600 });
  let fault: "429" | "partial" | "failure" | undefined, readHook: (() => Promise<void>) | undefined;
  const requests: string[] = [];
  const provider: typeof fetch = async (input, init) => {
    requests.push(`${init?.method} ${new URL(String(input)).pathname}`); assert.equal(init?.method, "GET");
    await readHook?.(); if (fault === "failure") throw new Error("synthetic queue read failure");
    if (fault === "429") return new Response(null, { status: 429, headers: { "X-RateLimit-Reset": "10" } });
    const row = (id: string, recalled: boolean, date: string, selected = typeId) => ({ id, archived_at: null, recalled, recall_at: date, notes: notesCanary,
      patient: { links: { self: `https://api.au5.cliniko.com/v1/patients/${patientCanary}` } }, recall_type: { links: { self: `https://api.au5.cliniko.com/v1/recall_types/${selected}` } } });
    return Response.json({ total_entries: fault === "partial" ? 5 : 4,
      recalls: [row("1", false, yesterday), row("2", false, day), row("3", true, yesterday), row("4", false, yesterday, "8")] });
  };
  const config = { db, scope, apiKey, contactEmail: "monitor@example.test", businessId: "11", recallTypeId: typeId, timeZone: zone, policyVersion: "1",
    staffApprovalPath: staffPath, monitorApprovalPath: monitorPath, directory: new OwnerFileAdminDirectory(adminPath, scope),
    destination, alertTokenHex: token, pollEveryMinutes: 15, allowTestLoopbackHttp: true, clinikoFetch: provider, clock };
  return { folder, db, databaseUrl, config, inbox, requests, adminPath, staffPath, monitorPath, accounts, staff, approval,
    replace: async (patch: Partial<QueueMonitorApproval>) => writeFile(monitorPath, JSON.stringify({ ...approval, ...patch }), { mode: 0o600 }),
    onRead: (hook: () => Promise<void>) => { readHook = hook; }, fault: (value: typeof fault) => { fault = value; },
    async monitor() { const value = await ClinikoQueueMonitor.create(config); assert.equal(value.ok, true); if (!value.ok) throw new Error("test monitor unavailable"); return value.value; },
    async scan() {
      const canaries = [{ label: "patient", value: patientCanary }, { label: "notes", value: notesCanary }];
      assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] }); assert.deepEqual(await scanDisposableBackupCanaries(databaseUrl, canaries), []);
      for (const name of await readdir(inboxPath)) for (const file of await readdir(join(inboxPath, name))) {
        const body = await readFile(join(inboxPath, name, file), "utf8");
        for (const value of [patientCanary, notesCanary, token, apiKey, scope.tenantId]) assert.equal(body.includes(value), false);
      }
    },
    async close() { await receiver.close(); await rm(folder, { recursive: true, force: true }); } };
}

test("E2E-220 queue alert thresholds cannot silently become voice runtime daily counters", () => {
  assert.throws(() => parseThresholds('{"clinikoQueueUnavailable":1}'), /invalid thresholds/);
  assert.deepEqual(parseAggregateAlertThresholds('{"clinikoQueueUnavailable":1}'), { clinikoQueueUnavailable: 1 });
});
describe("approved independent Cliniko queue monitoring", { concurrency: 2 }, () => {
  for (const mode of ["known", "partial"] as const) test(`E2E-220 separately compiled operator monitor ${mode} routes actual approved aggregate work to a real receiver`, options, async () => fixture(async f => {
    const child = spawn(process.execPath, [compiledRuntimeEntrypoint("test/support/start-synthetic-queue-monitor.ts")], {
      env: { ...process.env, DATABASE_URL: f.databaseUrl, ABBY_QUEUE_MONITOR_FIXTURE: mode, ABBY_TENANT_ID: f.config.scope.tenantId,
        ABBY_CLINIC_ID: f.config.scope.clinicId, ABBY_LOCATION_ID: f.config.scope.locationId, ABBY_CLINIKO_API_KEY: f.config.apiKey,
        ABBY_CLINIKO_CONTACT_EMAIL: f.config.contactEmail, ABBY_CLINIKO_BUSINESS_ID: f.config.businessId, ABBY_CLINIKO_RECALL_TYPE_ID: f.config.recallTypeId,
        ABBY_CLINIKO_RECALL_TIME_ZONE: f.config.timeZone, ABBY_CLINIKO_QUEUE_POLICY_VERSION: f.config.policyVersion, ABBY_CLINIKO_QUEUE_POLL_MINUTES: "15",
        ABBY_CLINIKO_STAFF_APPROVAL_PATH: f.staffPath, ABBY_CLINIKO_QUEUE_MONITOR_APPROVAL_PATH: f.monitorPath, ABBY_ADMIN_DIRECTORY_PATH: f.adminPath,
        ABBY_VOICE_ALERT_WEBHOOK_URL: f.config.destination, ABBY_VOICE_ALERT_TOKEN_HEX: f.config.alertTokenHex },
      stdio: ["ignore", "pipe", "pipe"], signal: AbortSignal.timeout(30_000),
    });
    let output = "", errors = ""; child.stdout.on("data", data => { output += data.toString(); }); child.stderr.on("data", data => { errors += data.toString(); });
    const [code] = await once(child, "exit"); assert.equal(code, mode === "known" ? 0 : 2);
    const result = JSON.parse(output);
    assert.deepEqual(result, mode === "known" ? { status: "queueKnown", accepted: 2, attempted: 2, pending: 2, overdue: 1 }
      : { status: "queueUnavailable", accepted: 1, attempted: 1 });
    assert.equal((await f.inbox.snapshot()).alerts.length, mode === "known" ? 2 : 1);
    for (const secret of [patientCanary, notesCanary, f.config.apiKey, f.config.alertTokenHex, f.config.scope.tenantId]) assert.equal((output + errors).includes(secret), false);
    await f.scan();
  }));
  test("E2E-220 complete selected-type health reaches a real durable receiver with current duty and backup approval", options, async () => fixture(async f => {
    const monitor = await f.monitor(), result = await monitor.run();
    assert.deepEqual(result, { status: "queueKnown", accepted: 2, attempted: 2, pending: 2, overdue: 1 });
    assert.deepEqual((await f.inbox.snapshot()).alerts.map(a => [a.kind, a.count]), [["clinikoQueueOverdue", 1], ["clinikoQueuePending", 2]]);
    assert.deepEqual(await monitor.run(), result); assert.equal((await f.inbox.snapshot()).alerts.length, 2);
    assert.ok(f.requests.every(r => r === "GET /v1/recalls"));
    const budgets = await f.db.selectFrom("cliniko_request_budgets").select("sent_at_ms").execute(); assert.equal(budgets.length, 1);
    assert.equal((budgets[0]!.sent_at_ms as number[]).length, 2); await f.scan();
  }));
  for (const fault of ["429", "partial", "failure"] as const) test(`E2E-220 ${fault} is queue unavailable, never a healthy zero or a partial count`, options, async () => fixture(async f => {
    const monitor = await f.monitor(); f.fault(fault); const result = await monitor.run();
    assert.deepEqual(result, { status: "queueUnavailable", accepted: 1, attempted: 1 });
    assert.equal(Object.hasOwn(result, "pending"), false); assert.equal(Object.hasOwn(result, "overdue"), false);
    assert.deepEqual((await f.inbox.snapshot()).alerts.map(a => [a.kind, a.count]), [["clinikoQueueUnavailable", 1]]); await f.scan();
  }));
  test("E2E-220 false approval, wrong duty/receiver/token and slower-than-declared polling cannot start a read", options, async () => fixture(async f => {
    for (const patch of [{ enabled: false }, { reviewBackupRef: "another" }, { destinationFingerprint: "0".repeat(64) },
      { alertTokenFingerprint: "0".repeat(64) }, { pollEveryMinutes: 40 }, { pendingThreshold: 0 }]) {
      await f.replace(patch); assert.equal((await ClinikoQueueMonitor.create(f.config)).ok, false);
    }
    assert.deepEqual(f.requests, []); assert.deepEqual((await f.inbox.snapshot()).alerts, []);
  }));
  for (const source of ["approval", "membership"] as const) test(`E2E-220 ${source} revoked during provider read prevents any alert after the held work`, options, async () => fixture(async f => {
    const monitor = await f.monitor(); f.onRead(async () => {
      if (source === "approval") await f.replace({ enabled: false });
      else await writeFile(f.adminPath, JSON.stringify([{ ...f.accounts[0], membershipVersion: "revoked" }]), { mode: 0o600 });
    });
    assert.deepEqual(await monitor.run(), { status: "approvalUnavailable", accepted: 0, attempted: 0 });
    assert.deepEqual((await f.inbox.snapshot()).alerts, []);
  }));
  test("E2E-220 changed approval after one accepted alert stops the next and reports the actual partial transport outcome", options, async () => fixture(async f => {
    let calls = 0;
    const value = await ClinikoQueueMonitor.create({ ...f.config, alertFetch: async (url, init) => {
      calls++; const response = await fetch(url, init); await f.replace({ enabled: false }); return response;
    } }); assert.ok(value.ok); if (!value.ok) return;
    assert.deepEqual(await value.value.run(), { status: "approvalUnavailable", accepted: 1, attempted: 1 });
    assert.equal(calls, 1); assert.equal((await f.inbox.snapshot()).alerts.length, 1);
  }));
  test("E2E-220 lost receiver result is not accepted or retried within the run; a fresh poll deduplicates the stored alert", options, async () => fixture(async f => {
    let calls = 0;
    const value = await ClinikoQueueMonitor.create({ ...f.config, alertFetch: async (url, init) => {
      calls++; const response = await fetch(url, init); await response.body?.cancel(); throw new Error("synthetic lost receiver result");
    } }); assert.ok(value.ok); if (!value.ok) return;
    assert.deepEqual(await value.value.run(), { status: "deliveryUnavailable", accepted: 0, attempted: 1 });
    assert.equal(calls, 1); assert.equal((await f.inbox.snapshot()).alerts.length, 1);
    assert.equal((await (await f.monitor()).run()).accepted, 2); assert.equal((await f.inbox.snapshot()).alerts.length, 2); await f.scan();
  }));
  test("E2E-220 aborted held provider work cannot report health, send late alerts or permit concurrent monitoring", options, async () => fixture(async f => {
    const monitor = await f.monitor(), stop = new AbortController(); let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.onRead(async () => { entered(); await held; }); const result = monitor.run(stop.signal); await started;
    assert.deepEqual(await monitor.run(), { status: "monitorBusy", accepted: 0, attempted: 0 });
    stop.abort(); assert.deepEqual(await result, { status: "approvalUnavailable", accepted: 0, attempted: 0 });
    release(); f.onRead(async () => {});
    assert.deepEqual((await f.inbox.snapshot()).alerts, []);
    assert.equal((await monitor.run()).status, "queueKnown");
  }));
});
