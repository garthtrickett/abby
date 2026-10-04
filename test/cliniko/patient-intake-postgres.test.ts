import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { intakeCredential, intakeDraft, intakeEdgeFixture } from "../support/intake-edge.ts";

test("E2E-292 actual intake duplicate/create/read-back share one PostgreSQL API-user budget and leave no draft or attempt in database/backup",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), databaseName = `abby_intake_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
    let created = false, database: ReturnType<typeof connectPostgres> | undefined;
    const owned: Awaited<ReturnType<typeof intakeEdgeFixture>>[] = [];
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
      database = connectPostgres(target.toString()); await migrate(database);
      const budget = new PostgresClinikoRequestBudget(database, { apiKey: intakeCredential, maxPerMinute: 3 });
      const f = await intakeEdgeFixture(budget); owned.push(f);
      assert.deepEqual(await f.create(), { ok: true, value: { kind: "created", patientRef: "cliniko:patient:42" } });
      assert.equal(f.posts, 1); assert.equal(f.traffic.length, 3);
      const next = await intakeEdgeFixture(new PostgresClinikoRequestBudget(database, { apiKey: intakeCredential, maxPerMinute: 3 }));
      owned.push(next); const denied = await next.create(); assert.equal(denied.ok, false);
      assert.equal(denied.error.kind, "rateLimited"); assert.equal(next.traffic.length, 0); assert.equal(next.posts, 0);
      const values = [intakeDraft.firstName, intakeDraft.lastName, intakeDraft.email, intakeDraft.dateOfBirth,
        intakeDraft.patientPhone, f.callId, f.sessionId, f.refs.draftRef, f.refs.consentRef, f.refs.authorityRef,
        f.request.attemptRef, "private provider chart canary"];
      const canaries = values.map((value, index) => ({ label: `intake_${index}`, value }));
      assert.deepEqual(await scanPatientDataCanaries(database, canaries), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
      assert.deepEqual(await database.selectFrom("calls").selectAll().execute(), []);
      assert.deepEqual(await database.selectFrom("patient_phone_index").selectAll().execute(), []);
      const saved = await database.selectFrom("cliniko_request_budgets").selectAll().execute();
      assert.equal(saved.length, 1); assert.ok(Array.isArray(saved[0]!.sent_at_ms));
      assert.equal(saved[0]!.sent_at_ms.length, f.traffic.length);
      for (const f of owned) f.close();
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    } finally {
      for (const f of owned) f.close();
      await database?.destroy();
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
