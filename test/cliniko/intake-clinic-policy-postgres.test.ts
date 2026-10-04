import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { PostgresClinicIntakeSettingStore } from "../../src/storage/postgres-clinic-intake-setting.ts";
import { PostgresPolicyStore } from "../../src/storage/postgres-policy-store.ts";
import { referenceDefaultPolicy } from "../../src/reference/policy-store.ts";
import { scanDisposableBackupCanaries } from "../storage/backup-canary-scan.ts";
import { exerciseIntakePolicySetting } from "../support/intake-policy-setting.ts";

test("E2E-293 actual PostgreSQL setting captures call versions, revokes public approval and stores no private draft or new patient work",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 60_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
    const admin = connectPostgres(adminUrl), name = `abby_intake_policy_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl); target.pathname = `/${name}`;
    let created = false, db: ReturnType<typeof connectPostgres> | undefined;
    try {
      await sql.raw(`create database "${name}"`).execute(admin); created = true;
      db = connectPostgres(target.toString()); await migrate(db);
      const proof = await exerciseIntakePolicySetting(new PostgresClinicIntakeSettingStore(db));
      const policy = new PostgresPolicyStore(db, referenceDefaultPolicy, "unavailable", undefined, false, "standaloneMinimal");
      const effective = await policy.read(proof.scope); assert.ok(effective.ok);
      assert.equal(effective.value.firstTimeIntakeEnabled, true); assert.equal(effective.value.firstTimeIntakeVersion, "3");
      assert.equal(effective.value.capabilities.intake, "unavailable", "public policy supplies no standalone create capability");
      const canaries = proof.canaries.filter(value => value !== "Mobile").map((value, index) => ({ label: `draft_${index}`, value }));
      assert.deepEqual(await scanPatientDataCanaries(db, canaries), { ok: true, value: [] });
      assert.deepEqual(await scanDisposableBackupCanaries(target.toString(), canaries), []);
      assert.deepEqual(await db.selectFrom("calls").selectAll().execute(), []);
      assert.deepEqual(await db.selectFrom("patient_phone_index").selectAll().execute(), []);
      const stored = await db.selectFrom("clinic_intake_settings").selectAll().execute(); assert.equal(stored.length, 4);
      for (const row of stored) assert.deepEqual(Object.keys(row).sort(),
        ["tenant_id", "clinic_id", "version", "enabled", "previous_enabled", "changed_by", "changed_at"].sort());
    } finally {
      await db?.destroy();
      try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); }
      finally { await admin.destroy(); }
    }
  });
