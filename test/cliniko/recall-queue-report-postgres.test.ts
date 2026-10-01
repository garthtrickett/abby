import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { collectClinikoRecallQueuePulse, publicRecallQueuePulse } from "../../scripts/read-cliniko-recall-queue.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";

const base = "https://api.au5.cliniko.com/v1";
const patientCanary = "918273645546372";
const noteCanary = "private recall summary canary";

test("E2E-228 owner-run Cliniko queue pulse uses shared budget and emits only complete aggregate counts",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL;
  assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl);
  const databaseName = `abby_recall_pulse_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  let created = false;
  let db: ReturnType<typeof connectPostgres> | undefined;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin);
    created = true;
    db = connectPostgres(target.toString());
    await migrate(db);
    let reads = 0;
    const fetchPort: typeof fetch = async (_input, init) => {
      reads += 1;
      assert.equal(init?.method, "GET");
      const row = (id: string, typeId: string) => ({ id, archived_at: null,
        recalled: false, recall_at: "2026-09-30", notes: noteCanary,
        patient: { links: { self: `${base}/patients/${patientCanary}` } },
        recall_type: { links: { self: `${base}/recall_types/${typeId}` } } });
      return Response.json({ total_entries: 2, recalls: [row("1", "7"), row("2", "8")] });
    };
    const config = { db, scope: { tenantId: "pulse-tenant", clinicId: "pulse-clinic" },
      apiKey: "synthetic-key-au5", contactEmail: "dev@example.test", recallTypeId: "7",
      timeZone: "Australia/Sydney", fetchPort,
      now: new Date("2026-09-30T15:00:00.000Z") };
    const pulse = await collectClinikoRecallQueuePulse(config);
    assert.equal(pulse.throughDate, "2026-10-01", "the clinic date must differ from UTC at this boundary");
    assert.deepEqual([pulse.scanned, pulse.pending, pulse.overdue, pulse.markedRecalled], [2, 1, 1, 0]);
    assert.equal(reads, 1);
    const publicView = publicRecallQueuePulse(pulse);
    assert.deepEqual(publicView, { schemaVersion: 1, kind: "cliniko-recall-queue-pulse",
      observedAt: pulse.observedAt, throughDate: "2026-10-01",
      scanned: 2, pending: 1, overdue: 1, markedRecalled: 0 });
    for (const secret of [patientCanary, noteCanary, "pulse-tenant", "pulse-clinic", "synthetic-key-au5"]) {
      assert.equal(JSON.stringify(publicView).includes(secret), false);
    }
    const budget = await db.selectFrom("cliniko_request_budgets").select(["sent_at_ms"]).execute();
    assert.equal(budget.length, 1);
    assert.equal((budget[0]?.sent_at_ms as number[]).length, 1);
    const canaries = [{ label: "patient", value: patientCanary }, { label: "note", value: noteCanary }];
    assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    await assert.rejects(() => collectClinikoRecallQueuePulse({ ...config, timeZone: "invalid/time-zone" }));
    assert.equal(reads, 1, "bad clinic time zone must not make a provider read");
  } finally {
    await db?.destroy();
    if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin);
    await admin.destroy();
  }
});
