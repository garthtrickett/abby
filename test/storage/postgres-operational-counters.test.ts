import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  assert.deepEqual(await counters.snapshot(scope), {
    admissionDenied: 80, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
  });
  assert.deepEqual(await counters.snapshot({ ...scope, locationId: "other" }), {
    admissionDenied: 0, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
  });
  assert.deepEqual(await counters.snapshot({ ...scope, clinicId: "other" }), {
    admissionDenied: 0, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0,
  });
  const columns = await sql<{ column_name: string }>`select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = 'clinic_operational_counts'
    order by ordinal_position`.execute(db);
  assert.deepEqual(columns.rows.map(row => row.column_name),
    ["tenant_id", "clinic_id", "location_id", "kind", "count"]);
  const canary = `patient-private-ops-${randomUUID()}`;
  const probes = [{ label: "patient", value: canary }];
  assert.deepEqual(await scanPatientDataCanaries(db, probes), { ok: true, value: [] });
  assert.deepEqual(await scanDisposableBackupCanaries(url, probes), []);
});
