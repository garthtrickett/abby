import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate, migrateTo } from "../../src/storage/migrate.ts";
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
  let crashedCode = "", ready: () => void = () => undefined;
  const children: ReturnType<typeof spawn>[] = [], output: string[] = [];
  const server = createServer((incoming, response) => {
    if (incoming.url === "/ready") { ready(); return; }
    if (incoming.url !== "/email" || incoming.method !== "POST") { response.writeHead(404).end(); return; }
    incoming.on("data", chunk => { crashedCode += String(chunk); });
    incoming.on("end", () => response.writeHead(202).end());
  });
  let first: ReturnType<typeof connectPostgres> | undefined, second: ReturnType<typeof connectPostgres> | undefined, created = false;
  try {
    await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
    first = connectPostgres(target.toString()); second = connectPostgres(target.toString()); await migrate(first);
    const a = new PostgresPatientVerificationBudget(first, scope), b = new PostgresPatientVerificationBudget(second, scope);
    const launch = (input: unknown) => {
      const child = spawn(process.execPath, ["test/support/email-patient-restart-worker.ts"], {
        cwd: new URL("../../", import.meta.url), env: { DATABASE_URL: target.toString() },
        stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(15_000),
      });
      children.push(child); let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
      const exited = once(child, "exit").then(([code, signal]) => { output.push(stdout, stderr); return { code, signal, stdout, stderr }; });
      child.stdin.end(JSON.stringify(input)); return { child, exited };
    };
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const owner = launch({ scope, mode: "issue", proxy: `http://127.0.0.1:${address.port}` });
    await Promise.race([waiting, owner.exited.then(() => { throw new Error("owner exited before challenge checkpoint"); })]);
    assert.match(crashedCode, /^[0-9]{6}$/); assert.equal(owner.child.kill("SIGKILL"), true);
    assert.equal((await owner.exited).signal, "SIGKILL");
    const fresh = await launch({ scope, mode: "answer", code: crashedCode }).exited;
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.deepEqual(JSON.parse(fresh.stdout), { verified: false, issueAllowed: true }, "old code fails while the shared budget still has capacity");
    const fixture = emailFixture({ scope, patientId: "482746192837465", budget: a });
    await fixture.authority.start("appointments.read"); assert.equal(fixture.mail.length, 1);
    const token = await fixture.authority.answer(fixture.mail[0]!.code); assert.ok(token.ok);
    fixture.authority.close(); fixture.proof.dispose();
    const issues = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).reserve({ ...scope, locationId: String(i) }, "issue")));
    assert.equal(issues.filter(Boolean).length, 27, "three previous reservations plus 27 concurrent reservations reach 30");
    const answers = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).reserve(scope, "answer")));
    assert.equal(answers.filter(Boolean).length, 88, "two previous answers plus 88 reach 90");
    assert.equal(await b.reserve({ ...scope, tenantId: "other" }, "issue"), false);
    const exhausted = await launch({ scope, mode: "answer", code: fixture.mail[0]!.code }).exited;
    assert.equal(exhausted.code, 0, exhausted.stderr);
    assert.deepEqual(JSON.parse(exhausted.stdout), { verified: false, issueAllowed: false }, "fresh process retains exhausted clinic limit");
    const rows = await first.selectFrom("patient_verification_budgets").selectAll().execute();
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["attempts", "clinic_id", "kind", "tenant_id", "window_started_at"]);
    const canaries = [fixture.mail[0]!.email, token.value, "482746192837465", "private-contact-canary"].map((value, i) => ({ label: `otp_${i}`, value }));
    assert.deepEqual(await scanPatientDataCanaries(first, canaries), { ok: true, value: [] });
    assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    for (const { value } of canaries) assert.ok(output.every(part => !part.includes(value)));
    await sql`update patient_verification_budgets set window_started_at = clock_timestamp() - interval '5 minutes 1 second'`.execute(first);
    assert.equal(await b.reserve(scope, "issue"), true); assert.equal(await a.reserve(scope, "answer"), true);
    assert.deepEqual((await first.selectFrom("patient_verification_budgets").select("attempts").execute()).map(row => row.attempts), [1, 1]);
    // Actual migration rollback and re-up, not hand-written schema changes.
    await migrateTo(first, "041_admin_magic_link_identity");
    const missing = await sql<{ relation: string | null }>`select to_regclass('public.patient_verification_budgets')::text as relation`.execute(first);
    assert.equal(missing.rows[0]?.relation, null, "rollback actually removes verification budget storage");
    assert.equal(await a.reserve(scope, "issue"), false, "missing budget storage denies issuance");
    await migrate(first); assert.equal(await b.reserve(scope, "issue"), true);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all([first?.destroy(), second?.destroy()]);
    try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
    finally { await admin.destroy(); }
  }
});
