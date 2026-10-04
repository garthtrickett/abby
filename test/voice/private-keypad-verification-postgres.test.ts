import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { verificationCanaries } from "../support/caller-verification.ts";
import { privateKeypadCallFixture } from "../support/private-keypad-call.ts";

test("E2E-294 actual keypad verifier uses PostgreSQL aggregate budget and keeps code, contact, call and proof out of tables and backups",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), name = `abby_keypad_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${name}`;
    let created = false, db: ReturnType<typeof connectPostgres> | undefined, f: Awaited<ReturnType<typeof privateKeypadCallFixture>> | undefined;
    try {
      await sql.raw(`create database "${name}"`).execute(admin); created = true;
      db = connectPostgres(target.toString()); await migrate(db);
      const scope = { tenantId: "keypad-budget", clinicId: "clinic", locationId: "main" };
      f = await privateKeypadCallFixture({ scope, budget: new PostgresPatientVerificationBudget(db, scope) });
      await f.start(); await f.mark(); await f.delivered; assert.ok(f.mail[0]);
      for (let i = 0; i < 8; i++) assert.ok((await f.media()).ok);
      assert.deepEqual(f.transcripts, []); assert.ok((await f.code(f.mail[0].code)).ok);
      const proof = await f.owner.verified(); assert.ok(proof);
      for (let i = 0; i < 7; i++) assert.ok((await f.media(i < 2)).ok);
      assert.equal(f.detailReads, 1);
      const canaries = [...verificationCanaries, f.mail[0].code, proof.verificationRef, f.sessionId, f.callId]
        .map((value, index) => ({ label: `keypad_${index}`, value }));
      assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
      assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []);
      assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
      const rows = await db.selectFrom("patient_verification_budgets").selectAll().execute(); assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(row => [row.kind, row.attempts]).sort(), [["answer", 1], ["issue", 1]]);
      for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["attempts", "clinic_id", "kind", "tenant_id", "window_started_at"]);
      await f.close(); assert.equal(await f.owner.verified(), undefined);
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
    } finally {
      await f?.close(); await db?.destroy();
      try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
