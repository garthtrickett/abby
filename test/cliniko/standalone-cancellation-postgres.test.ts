import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import type { PatientVerificationBudgets } from "../../src/storage/generated/public/PatientVerificationBudgets.ts";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { cancellationFixture, cancellationCanaries } from "../support/standalone-cancellation.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-272 actual text cancellation uses PostgreSQL aggregate abuse limits without storing its private action/review/proof",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl), name = `abby_cancel_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let db: ReturnType<typeof connectPostgres> | undefined, created = false;
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    for (const scenario of ["success", "writeLost"] as const) {
      const app = await cancellationFixture(scenario, scope => new PostgresPatientVerificationBudget(db!, scope));
      try {
        const verificationRef = await app.verify(); resultValue(await app.propose(verificationRef)); await app.confirm();
        const outcome = await app.drain(), action = Object.values(outcome.actions)[0]!;
        assert.equal(action.status, scenario === "success" ? "committed" : "uncertain"); assert.equal(app.patches, 1);
        assert.equal((await app.discovery()).pending.length, 1); await app.drain(); assert.equal(app.patches, 1);
        const canaries = [...cancellationCanaries, verificationRef, app.mail[0]!.code, String(app.recalls[0]!.notes).split("\n")[0]!,
          app.callId, app.sessionId, action.key, "2026-10-08T04:00:00.000Z"].map((value, index) => ({ label: `cancel_${index}`, value }));
        assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
        assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
        const rows: PatientVerificationBudgets[] = await db.selectFrom("patient_verification_budgets").selectAll().execute();
        const budgets = rows.filter(row => row.tenant_id === app.scope.tenantId);
        assert.equal(budgets.length, 2); assert.ok(budgets.every(row => row.attempts === 1));
        assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []);
        assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
      } finally { app.host.dispose(); app.email.close(); }
    }
  } finally {
    await db?.destroy();
    try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
