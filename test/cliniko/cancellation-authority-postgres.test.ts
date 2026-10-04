import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { concreteCancellationFixture } from "../support/cancellation-authority.ts";
import { cancellationCanaries } from "../support/standalone-cancellation.ts";

test("E2E-276 concrete policy/target cancellation leaves selections, appointment work and review context outside PostgreSQL and backups",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), databaseName = `abby_target_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
    let created = false, database: ReturnType<typeof connectPostgres> | undefined;
    let f: Awaited<ReturnType<typeof concreteCancellationFixture>> | undefined;
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
      database = connectPostgres(target.toString()); await migrate(database);
      const scope = { tenantId: `target-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
      f = await concreteCancellationFixture({ scope, budget: new PostgresPatientVerificationBudget(database, scope) });
      const proofRef = await f.verify(), targetRef = await f.select(proofRef);
      assert.ok((await f.propose(proofRef, targetRef)).ok); await f.confirm(); await f.drain();
      assert.equal(f.patches, 1); assert.equal(f.traffic.filter(value => value.startsWith("PATCH ")).length, 1);
      assert.equal((await f.discovery()).pending.length, 1, "review remains Cliniko-owned and is not closed automatically");
      const canaries = [...cancellationCanaries, proofRef, targetRef, f.callId, f.sessionId, "2026-10-08T04:00:00.000Z"]
        .map((value, i) => ({ label: `target_${i}`, value }));
      assert.deepEqual(await scanPatientDataCanaries(database, canaries), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
      assert.deepEqual(await database.selectFrom("calls").selectAll().execute(), []);
      assert.deepEqual(await database.selectFrom("patient_phone_index").selectAll().execute(), []);
      const saved = await database.selectFrom("patient_verification_budgets").selectAll().execute();
      assert.equal(saved.length, 2); for (const row of saved) assert.deepEqual(Object.keys(row).sort(), ["attempts", "clinic_id", "kind", "tenant_id", "window_started_at"]);
    } finally {
      await f?.close(); await database?.destroy();
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
