import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { sql } from "kysely";
import test from "node:test";
import { sendVoiceOperationalAlerts } from "../../scripts/send-voice-operational-alerts.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { compiledRuntimeEntrypoint } from "../support/compiled-runtime-entrypoint.ts";

async function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [compiledRuntimeEntrypoint("scripts/serve-voice-operational-alert-receiver.ts")],
    { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stderr.on("data", data => { errors += data.toString(); });
  const ready = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("compiled operational receiver did not bind")); }, 15_000);
    const cleanup = () => { clearTimeout(timeout); child.stdout.off("data", data); child.off("exit", exit); };
    const exit = () => { cleanup(); reject(new Error("compiled operational receiver exited")); };
    const data = (chunk: Buffer) => {
      output += chunk.toString(); if (output.length > 4_096) { cleanup(); reject(new Error("invalid receiver readiness")); return; }
      if (!output.includes("\n")) return;
      try { const value = JSON.parse(output.split("\n")[0]!); assert.ok(Number.isInteger(value.port) && value.port > 0 && value.port <= 65_535); cleanup(); resolve(value.port); }
      catch { cleanup(); reject(new Error("invalid receiver readiness")); }
    };
    child.stdout.on("data", data); child.once("exit", exit);
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"), timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.kill("SIGTERM"); try { assert.equal((await exited)[0], 0); } finally { clearTimeout(timeout); }
  };
  try { return { child, port: await ready, close, output: () => output + errors }; }
  catch (error) { await close(); throw error; }
}

test("E2E-220 PostgreSQL sender reaches two compiled receivers; real lost response and SIGKILL restart cannot duplicate aggregate receipts",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 120_000 }, async () => {
  const url = process.env.DATABASE_URL; assert.ok(url);
  const admin = connectPostgres(url), name = `abby_test_alert_${randomUUID().replaceAll("-", "")}`, target = new URL(url); target.pathname = `/${name}`;
  const directory = await mkdtemp(join(tmpdir(), "abby-alert-receiver-"));
  let db: ReturnType<typeof connectPostgres> | undefined, created = false;
  const receivers: Awaited<ReturnType<typeof start>>[] = [];
  const today = new Date().toISOString().slice(0, 10), yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  const tenantId = `receiver-${randomUUID()}`, token = "b".repeat(64), canary = "private-alert-patient-canary";
  const env = { ...process.env, DATABASE_URL: target.toString(), ABBY_TENANT_ID: tenantId, ABBY_CLINIC_ID: "clinic", ABBY_LOCATION_ID: "main",
    ABBY_VOICE_ALERT_TOKEN_HEX: token, ABBY_VOICE_OPS_THRESHOLDS_JSON: '{"voiceFailure":2,"clinikoProvider429":1}',
    ABBY_VOICE_ALERT_INBOX_DIRECTORY: directory, ABBY_VOICE_ALERT_RECEIVER_PORT: "0", ABBY_PATIENT_CANARY: canary };
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    await sql`insert into clinic_operational_daily_counts (tenant_id, clinic_id, location_id, date, kind, count) values
      (${tenantId}, 'clinic', 'main', ${yesterday}::date, 'voiceFailure', 3), (${tenantId}, 'clinic', 'main', ${today}::date, 'voiceFailure', 4),
      ('foreign-receiver', 'clinic', 'main', ${today}::date, 'voiceFailure', 99)`.execute(db);
    const a = await start(env), b = await start(env); receivers.push(a, b);
    const send = (port: number, settings = env.ABBY_VOICE_OPS_THRESHOLDS_JSON) => sendVoiceOperationalAlerts({ ...env,
      ABBY_VOICE_OPS_THRESHOLDS_JSON: settings, ABBY_VOICE_ALERT_WEBHOOK_URL: `http://127.0.0.1:${port}/voice-operational-alerts` }, { allowTestLoopbackHttp: true });
    const accepted = await Promise.all([send(a.port), send(b.port)]);
    assert.deepEqual(accepted, [{ date: today, accepted: 2 }, { date: today, accepted: 2 }]);
    const read = async () => JSON.parse((await promisify(execFile)(process.execPath,
      [compiledRuntimeEntrypoint("scripts/read-voice-operational-alert-inbox.ts")], { env, timeout: 15_000 })).stdout) as { schemaVersion: number; alerts: { date: string; kind: string; count: number; threshold: number }[] };
    assert.deepEqual((await read()).alerts.map(row => row.count), [3, 4]);
    await sql`insert into clinic_operational_daily_counts (tenant_id, clinic_id, location_id, date, kind, count)
      values (${tenantId}, 'clinic', 'main', ${today}::date, 'clinikoProvider429', 1)`.execute(db);
    let requests = 0, committed = false; let killed: Promise<unknown[]> | undefined;
    // Forward a real POST to the receiver, then lose the real upstream response
    // on the sender's socket and kill the process after durable acceptance.
    const proxy = createServer((request, response) => {
      const task = (async () => {
        requests++; const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const upstream = await fetch(`http://127.0.0.1:${a.port}/voice-operational-alerts`, { method: "POST", headers: {
          authorization: request.headers.authorization!, "content-type": "application/json", "idempotency-key": String(request.headers["idempotency-key"]) }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(5_000) });
        await upstream.body?.cancel(); committed = upstream.status === 202;
        killed = once(a.child, "exit"); a.child.kill("SIGKILL"); response.destroy();
      })();
      void task.catch(() => { response.destroy(); });
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const address = proxy.address(); assert.ok(address && typeof address !== "string");
      await assert.rejects(send(address.port, '{"clinikoProvider429":1}'), /operational alert delivery unavailable/);
      assert.equal(requests, 1, "sender cannot silently retry an uncertain POST"); assert.equal(committed, true);
      assert.ok(killed); await killed; assert.equal(a.child.signalCode, "SIGKILL");
    } finally { const closed = new Promise<void>(resolve => proxy.close(() => resolve())); proxy.closeAllConnections(); await closed; }
    const restarted = await start(env); receivers.push(restarted);
    assert.equal((await read()).alerts.length, 3, "fresh reader recovers acceptance after actual process loss");
    assert.deepEqual(await send(restarted.port), { date: today, accepted: 3 });
    assert.equal((await read()).alerts.length, 3, "catch-up after restart cannot create another logical alert");
    const roots = await readdir(directory); assert.equal(roots.length, 1);
    const names = await readdir(join(directory, roots[0]!)); assert.equal(names.length, 3);
    const files = await Promise.all(names.map(file => readFile(join(directory, roots[0]!, file), "utf8")));
    for (const secret of [canary, token, tenantId, "foreign-receiver", "patient", "callId", "alertKey"]) {
      assert.equal(JSON.stringify(files).includes(secret), false); assert.equal(JSON.stringify(await read()).includes(secret), false);
      assert.ok(receivers.every(receiver => !receiver.output().includes(secret)));
    }
    const canaries = [{ label: "patient", value: canary }];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
  } finally {
    for (const receiver of receivers) await receiver.close();
    await db?.destroy(); if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin);
    await admin.destroy(); await rm(directory, { recursive: true, force: true });
  }
});
