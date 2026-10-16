import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { sql } from "kysely";
import { createDisposablePostgres, withDisposablePostgres } from "../support/disposable-postgres.ts";

test("disposable PostgreSQL provides migrated private storage and concurrent close waits for complete resource cleanup", async () => {
  const resource = await createDisposablePostgres();
  const socket = new URL(resource.connectionString).searchParams.get("host"); assert.ok(socket);
  try {
    const rows = await sql<{ count: number }>`select count(*)::integer as count from kysely_migration`.execute(resource.db);
    assert.ok(rows.rows[0]!.count > 0);
    const firstClose = resource.close(); await resource.close();
    await assert.rejects(access(socket), { code: "ENOENT" });
    await assert.rejects(sql`select 1`.execute(resource.db));
    await firstClose;
  } finally { await resource.close(); }
});

test("disposable PostgreSQL callback preserves its failure and removes its owned database socket", async () => {
  const failure = new Error("synthetic callback failure"); let socket: string | null = null;
  await assert.rejects(withDisposablePostgres(async (db, connectionString) => {
    socket = new URL(connectionString).searchParams.get("host");
    await sql`select 1`.execute(db); throw failure;
  }), error => error === failure);
  assert.ok(socket); await assert.rejects(access(socket), { code: "ENOENT" });
});
