import assert from "node:assert/strict";
import test from "node:test";
import crypto, { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";
import { scanPatientDataCanaries } from "../../src/storage/patient-data-canary-scan.ts";
import { distinctFromClock } from "../support/verification-code-canary.ts";
import { captureScopedSqlVerificationCanaryWindow } from "../support/sql-verification-canary.ts";

test("SQL verification draws reject pre-challenge schema and unrelated data while actual code leaks remain visible in every column and full backup", async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const admin = connectPostgres(adminUrl), name = `abby_test_schema_canary_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(adminUrl); target.pathname = `/${name}`;
  let db: ReturnType<typeof connectPostgres> | undefined, created = false;
  let canary: Awaited<ReturnType<typeof captureScopedSqlVerificationCanaryWindow>> | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "randomInt")!;
  const dump = () => execFileSync("pg_dump", [target.toString(), "--no-owner", "--no-privileges"],
    { timeout: 10000, maxBuffer: 8000000 }).toString();
  try {
    await sql.raw(`create database "${name}"`).execute(admin); created = true;
    db = connectPostgres(target.toString()); await migrate(db);
    const now = Date.now(), window = { sinceMs: now - 65000, throughMs: now + 605000 };
    const eligible = Array.from({ length: 90000 }, (_, i) => 100000 + i * 10).filter(code => distinctFromClock(code, window));
    const schemaCode = eligible[0]!, rowCode = eligible[1]!;
    assert.ok(Number.isInteger(schemaCode) && Number.isInteger(rowCode));
    await sql.raw(`create table public.canary_baseline (value integer check (value <= ${schemaCode}), echo text)`).execute(db);
    await sql`insert into canary_baseline values (null, ${`pre-existing public sentinel ${rowCode}`})`.execute(db);
    const before = dump();
    assert.ok(before.includes(String(schemaCode)) && before.includes(String(rowCode)));
    assert.deepEqual(await scanPatientDataCanaries(db, [{ label: "schema_code", value: String(schemaCode) }]), { ok: true, value: [] },
      "a schema-only numeric match is absent from every data column");
    const safe = eligible.find(code => !before.includes(String(code))); assert.ok(safe);
    const draws = [schemaCode, rowCode, safe]; let calls = 0;
    const rawDraw = crypto.randomInt;
    Object.defineProperty(crypto, "randomInt", { ...descriptor, value: (...args: unknown[]) => {
      if (args.length === 2 && args[0] === 0 && args[1] === 1000000) {
        assert.ok(calls < draws.length, "synthetic source draw exhausted"); return draws[calls++]!;
      }
      return Reflect.apply(rawDraw, crypto, args);
    } });
    syncBuiltinESMExports();
    canary = await captureScopedSqlVerificationCanaryWindow(db, target.toString());
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    assert.equal(code, String(safe), "pre-challenge schema and unrelated-row numbers must be rejected before issuing a code");
    assert.equal(calls, 3);
    const query = [{ label: "actual_code", value: code }];
    assert.deepEqual(await scanPatientDataCanaries(db, query), { ok: true, value: [] });
    assert.equal(dump().includes(code), false);
    await sql`insert into canary_baseline values (null, ${`actual private code ${code}`})`.execute(db);
    assert.deepEqual(await scanPatientDataCanaries(db, query),
      { ok: true, value: [{ label: "actual_code", table: "canary_baseline", column: "echo" }] });
    const after = dump();
    assert.equal(after.includes(code), true, "a post-issue raw-code leak is detected in the same unfiltered backup");
    assert.ok(after.includes(String(rowCode)), "unrelated legitimate data is retained");
  } finally {
    try { canary?.close(); } finally {
      Object.defineProperty(crypto, "randomInt", descriptor); syncBuiltinESMExports();
      await db?.destroy();
      try { if (created) await sql.raw(`drop database "${name}" with (force)`).execute(admin); } finally { await admin.destroy(); }
    }
  }
});

test("SQL verification snapshot refuses another server or database before changing the code issuer", async () => {
  const adminUrl = process.env.DATABASE_URL; assert.ok(adminUrl);
  const db = connectPostgres(adminUrl), before = crypto.randomInt;
  try {
    const foreign = new URL(adminUrl); foreign.port = String(Number(foreign.port || "5432") + 1);
    await assert.rejects(captureScopedSqlVerificationCanaryWindow(db, foreign.toString()), /isolated fixture server/);
    assert.equal(crypto.randomInt, before);
    const wrong = new URL(adminUrl); wrong.pathname = "/abby_test_another_database";
    await assert.rejects(captureScopedSqlVerificationCanaryWindow(db, wrong.toString()), /exact connected fixture database/);
    assert.equal(crypto.randomInt, before);
  } finally { await db.destroy(); }
});
