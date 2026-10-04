import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresClinikoRequestBudget } from "../../src/storage/postgres-cliniko-request-budget.ts";
import { PostgresPatientVerificationBudget } from "../../src/storage/postgres-patient-verification-budget.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { intakeCredential, intakeDraft } from "../support/intake-edge.ts";
import { intakeSessionFixture } from "../support/intake-session.ts";
import { resultValue } from "../support/agent-appointment-proposals.ts";

test("E2E-295 actual admitted intake uses shared PostgreSQL issue/answer/API budgets without persisting draft, consent, code, action or outcome",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), name = `abby_intake_call_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${name}`;
    let created = false, db: ReturnType<typeof connectPostgres> | undefined, f: Awaited<ReturnType<typeof intakeSessionFixture>> | undefined;
    try {
      await sql.raw(`create database "${name}"`).execute(admin); created = true;
      db = connectPostgres(target.toString()); await migrate(db);
      const scope = { tenantId: "intake-policy", clinicId: "clinic", locationId: "main" };
      f = await intakeSessionFixture({ rateBudget: new PostgresClinikoRequestBudget(db, { apiKey: intakeCredential, maxPerMinute: 3 }),
        verificationBudget: new PostgresPatientVerificationBudget(db, scope) });
      const ref = await f.prepare(); resultValue(await f.propose(ref)); resultValue(await f.confirm()); resultValue(await f.drain());
      const action = Object.values((await f.state()).actions)[0]!;
      assert.equal(action.status, "committed"); assert.equal(f.posts, 1); assert.equal(f.traffic.length, 3);
      const values = [...Object.values(intakeDraft), f.mail[0]!.code, f.callId, f.sessionId, ref, action.key, action.digest,
        action.hostRef!, action.mutation.request.kind === "intake" ? action.mutation.request.consentRef : "no-consent",
        "private intake provider notes"];
      const canaries = values.map((value, index) => ({ label: `intake_call_${index}`, value }));
      for (let offset = 0; offset < canaries.length; offset += 12) {
        assert.deepEqual(await scanPatientDataCanaries(db, canaries.slice(offset, offset+12)), { ok: true, value: [] });
      }
      for (let offset = 0; offset < canaries.length; offset += 12) {
        assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries.slice(offset, offset+12)), []);
      }
      assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []);
      assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
      const provider = await db.selectFrom("cliniko_request_budgets").selectAll().execute(); assert.equal(provider.length, 1); assert.ok(Array.isArray(provider[0]!.sent_at_ms)); assert.equal(provider[0]!.sent_at_ms.length, 3);
      const codes = await db.selectFrom("patient_verification_budgets").selectAll().execute(); assert.equal(codes.length, 2);
      assert.deepEqual(codes.map(row => [row.kind, row.attempts]).sort(), [["answer", 1], ["issue", 1]]);
      const exhausted = await new PostgresClinikoRequestBudget(db, { apiKey: intakeCredential, maxPerMinute: 3 }).claim();
      assert.equal(exhausted?.kind, "rateLimited");
      await f.close(); for (let offset = 0; offset < canaries.length; offset += 12) {
        assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries.slice(offset, offset+12)), []);
      }
    } finally {
      await f?.close(); await db?.destroy();
      try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
