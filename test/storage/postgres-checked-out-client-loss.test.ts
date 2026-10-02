import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

test("E2E-176 checked-out PostgreSQL client loss preserves its process and fails its query",
  { skip: process.env.ABBY_ISOLATED_POSTGRES_PROBE !== "1", timeout: 30_000 }, async () => {
    const adminUrl = process.env.DATABASE_URL;
    assert.ok(adminUrl);
    const databaseName = `abby_test_checked_out_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(adminUrl);
    target.pathname = `/${databaseName}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
      const child = spawnSync(process.execPath, ["test/support/checked-out-client-loss.ts"], {
        cwd: new URL("../../", import.meta.url),
        env: { ...process.env, DATABASE_URL: target.toString() },
        encoding: "utf8", timeout: 15_000,
      });
      assert.equal(child.error, undefined, "checked-out client probe must finish");
      assert.equal(child.status, 0, `checked-out client probe exited ${child.status ?? "unknown"}`);
      assert.equal(child.stdout.trim(), "checked-out connection loss handled");
    } finally {
      try { await admin.query(`drop database if exists "${databaseName}" with (force)`); }
      finally { await admin.end(); }
    }
  });
