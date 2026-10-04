import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { emailFixture } from "../support/email-patient-fixture.ts";

test("E2E-269 process-independent clinic budgets survive restart without persisting challenge/address/patient state",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl), databaseName = `abby_otp_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
  const scope = { tenantId: `otp-${randomUUID()}`, clinicId: "clinic", locationId: "location" };
  let first: ReturnType<typeof connectPostgres> | undefined, second: ReturnType<typeof connectPostgres> | undefined, created = false;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    first = connectPostgres(target.toString()); second = connectPostgres(target.toString()); await migrate(first);
    const a = new PostgresPatientVerificationBudget(first, scope), b = new PostgresPatientVerificationBudget(second, scope);
    const fixture = emailFixture({ scope, patientId: "482746192837465", budget: a });
    await fixture.authority.start("appointments.read"); assert.equal(fixture.mail.length, 1);
    const token = await fixture.authority.answer(fixture.mail[0]!.code); assert.ok(token.ok);
    fixture.authority.close(); fixture.proof.dispose();
    const issues = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).reserve({ ...scope, locationId: String(i) }, "issue")));
    assert.equal(issues.filter(Boolean).length, 29, "one previous issue plus 29 concurrent reservations reach 30");
    const answers = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).reserve(scope, "answer")));
    assert.equal(answers.filter(Boolean).length, 89, "one previous answer plus 89 reach 90");
    assert.equal(await b.reserve({ ...scope, tenantId: "other" }, "issue"), false);
    const child = spawn(process.execPath, ["test/support/email-patient-restart-worker.ts"], {
      cwd: new URL("../../", import.meta.url), env: { DATABASE_URL: target.toString() },
      stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(15_000),
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
    const exited = once(child, "exit"); child.stdin.end(JSON.stringify({ scope, code: fixture.mail[0]!.code }));
    assert.equal((await exited)[0], 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { verified: false, issueAllowed: false }, "fresh process loses proof, retains exhausted clinic limit");
    const rows = await first.selectFrom("patient_verification_budgets").selectAll().execute();
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["attempts", "clinic_id", "kind", "tenant_id", "window_started_at"]);
    const canaries = [fixture.mail[0]!.email, token.value, "482746192837465", "private-contact-canary"].map((value, i) => ({ label: `otp_${i}`, value }));
    assert.deepEqual(await scanPatientDataCanaries(first, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    for (const { value } of canaries) assert.equal((stdout+stderr).includes(value), false);
    await sql`update patient_verification_budgets set window_started_at = clock_timestamp() - interval '5 minutes 1 second'`.execute(first);
    assert.equal(await b.reserve(scope, "issue"), true); assert.equal(await a.reserve(scope, "answer"), true);
    assert.deepEqual((await first.selectFrom("patient_verification_budgets").select("attempts").execute()).map(row => row.attempts), [1, 1]);
    // Actual migration rollback and re-up, not hand-written schema changes.
    await migrate(first, "down");
    assert.equal(await a.reserve(scope, "issue"), false, "missing budget storage denies issuance");
    await migrate(first); assert.equal(await b.reserve(scope, "issue"), true);
  } finally {
    await Promise.all([first?.destroy(), second?.destroy()]);
    try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
