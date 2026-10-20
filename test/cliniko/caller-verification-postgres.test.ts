import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { callerVerificationFixture, verificationCanaries } from "../support/caller-verification.ts";
import type { CallerVerificationSession } from "../../src/standalone/caller-verification-session.ts";

test("E2E-274 E2E-418 actual caller-session/gateway and renewed verifier use shared PostgreSQL budget while code/proof/contact remain transient",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), databaseName = `abby_caller_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
    let created = false, database: ReturnType<typeof connectPostgres> | undefined;
    let fixture: Awaited<ReturnType<typeof callerVerificationFixture>> | undefined;
    let renewed: CallerVerificationSession | undefined;
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
      database = connectPostgres(target.toString()); await migrate(database);
      const scope = { tenantId: `caller-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
      const budget = new PostgresPatientVerificationBudget(database, scope);
      fixture = await callerVerificationFixture({ scope, budget });
      fixture.session.begin();
      const deadline = Date.now() + 5000;
      while (!fixture.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.equal(fixture.mail.length, 1);
      assert.deepEqual(await fixture.session.submitCode(fixture.mail[0]!.code), { verified: true });
      const grant = await fixture.session.verified(); assert.ok(grant);
      await fixture.read(grant.verificationRef); assert.ok(fixture.provider.includes("/v1/individual_appointments"));
      const stored = await database.selectFrom("patient_verification_budgets").selectAll().execute();
      assert.deepEqual(stored.map(row => [row.kind, row.attempts]).sort(), [["answer", 1], ["issue", 1]]);
      for (const row of stored) assert.deepEqual(Object.keys(row).sort(), ["attempts", "clinic_id", "kind", "tenant_id", "window_started_at"]);
      const handoff = await fixture.session.renewOnce(grant.verificationRef, new AbortController().signal); assert.ok(handoff.ok);
      renewed = handoff.value; renewed.begin();
      const renewalDeadline = Date.now() + 5000;
      while (fixture.mail.length < 2 && Date.now() < renewalDeadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.equal(fixture.mail.length, 2); assert.deepEqual(await renewed.submitCode(fixture.mail[1]!.code), { verified: true });
      const freshGrant = await renewed.verified(); assert.ok(freshGrant); assert.notEqual(freshGrant.verificationRef, grant.verificationRef);
      assert.equal(await fixture.session.verified(), undefined);
      assert.deepEqual((await database.selectFrom("patient_verification_budgets").selectAll().execute()).map(row => [row.kind, row.attempts]).sort(), [["answer", 2], ["issue", 2]]);
      const canaries = [...verificationCanaries, grant.verificationRef, freshGrant.verificationRef, ...fixture.mail.map(m => m.code)].map((value, i) => ({ label: `caller_${i}`, value }));
      assert.deepEqual(await scanPatientDataCanaries(database, canaries), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
      for (const { value } of canaries) assert.equal(JSON.stringify(await fixture.state()).includes(value), false);
      assert.equal(JSON.stringify(await fixture.state()).includes(fixture.mail[0]!.code), false);
      fixture.session.dispose(); assert.equal(await fixture.session.verified(), undefined);
      const fresh = await callerVerificationFixture({ scope, budget });
      try {
        assert.deepEqual(await fresh.session.submitCode(fixture.mail[0]!.code), { verified: false });
        assert.equal((await fresh.session.proof.verifyPatient(scope, grant.verificationRef, "2026-10-04T06:00:00.000Z")).ok, false);
        assert.equal(await budget.reserve(scope, "issue"), true, "lost authority is denied while shared budget retains capacity");
      } finally { await fresh.close(); }
    } finally {
      renewed?.dispose(); await fixture?.close(); await database?.destroy();
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
