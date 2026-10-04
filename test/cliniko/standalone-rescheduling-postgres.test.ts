import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { standaloneReschedulingFixture } from "../support/standalone-rescheduling.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";

test("E2E-285 reviewed standalone in-place move with actual provider and verification budgets leaves selections, appointment work and review context outside PostgreSQL and backups",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), databaseName = `abby_move_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${databaseName}`;
    let created = false, database: ReturnType<typeof connectPostgres> | undefined;
    let f: Awaited<ReturnType<typeof standaloneReschedulingFixture>> | undefined;
    try {
      await sql.raw(`create database "${databaseName}"`).execute(admin); created = true;
      database = connectPostgres(target.toString()); await migrate(database);
      const scope = { tenantId: `owner-${randomUUID()}`, clinicId: "clinic", locationId: "main" };
      f = await standaloneReschedulingFixture({ scope, verificationBudget: new PostgresPatientVerificationBudget(database, scope),
        rateBudget: new PostgresClinikoRequestBudget(database, { apiKey: "synthetic-session-au5" }) });
      f.session.begin(); const deadline = Date.now() + 5000;
      while (!f.mail.length && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 5));
      assert.ok(f.mail[0]); assert.equal((await f.session.submitCode(f.mail[0].code)).verified, true);
      const grant = await f.session.verified(); assert.ok(grant); const proofRef = grant.verificationRef;
      assert.ok((await f.propose(proofRef)).ok); assert.ok((await f.confirm()).ok); await f.drain();
      assert.equal(f.patches, 1); assert.equal(f.traffic.filter(value => value === "PATCH /v1/individual_appointments/91").length, 1);
      const discovered = await f.discovery(); assert.ok(discovered.ok);
      assert.equal(discovered.value.pending.length, 1, "review remains Cliniko-owned and is not closed automatically");
      const canaries = [...verificationCanaries, f.mail[0].code, proofRef, f.callId, f.sessionId, String(f.recalls[0]!.notes), "2026-10-08T04:00:00.000Z", "2026-10-08T05:00:00.000Z"]
        .map((value, i) => ({ label: `target_${i}`, value }));
      assert.deepEqual(await scanPatientDataCanaries(database, canaries), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
      assert.deepEqual(await database.selectFrom("calls").selectAll().execute(), []);
      assert.deepEqual(await database.selectFrom("patient_phone_index").selectAll().execute(), []);
      const requests = await database.selectFrom("cliniko_request_budgets").selectAll().execute();
      assert.equal(requests.length, 1); assert.ok(Array.isArray(requests[0]!.sent_at_ms));
      assert.equal(requests[0]!.sent_at_ms.length, f.traffic.length, "one API-user bucket covers every provider request");
      const saved = await database.selectFrom("patient_verification_budgets").selectAll().execute();
      assert.equal(saved.length, 2); for (const row of saved) assert.deepEqual(Object.keys(row).sort(), ["attempts", "clinic_id", "kind", "tenant_id", "window_started_at"]);
    } finally {
      await f?.close(); await database?.destroy();
      try { if (created) await sql.raw(`drop database "${databaseName}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
