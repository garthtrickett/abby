import assert from "node:assert/strict";
import { sql } from "kysely";
import { Client } from "pg";
import { connectPostgres } from "../../src/storage/connect.ts";

const connectionString = process.env.DATABASE_URL;
assert.ok(process.env.ABBY_ISOLATED_POSTGRES_PROBE === "1" && connectionString &&
  new URL(connectionString).pathname.startsWith("/abby_test_checked_out_"),
  "checked-out client probe requires its own disposable database");

const db = connectPostgres(connectionString);
const admin = new Client({ connectionString });
await admin.connect();
let queryFailed = false;
try {
  try {
    await db.connection().execute(async connection => {
      const backend = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(connection);
      const result = await admin.query<{ stopped: boolean }>(
        "select pg_terminate_backend($1) as stopped", [backend.rows[0]!.pid]);
      assert.equal(result.rows[0]?.stopped, true);
      // Allow the checked-out client to emit its asynchronous connection error.
      await new Promise(resolve => setTimeout(resolve, 200));
      try { await sql`select 1`.execute(connection); }
      catch { queryFailed = true; }
    });
  } catch (error) {
    if (!queryFailed) throw error;
  }
  assert.ok(queryFailed, "a dead checked-out connection must not return query success");
} finally {
  await db.destroy();
  await admin.end();
}
process.stdout.write("checked-out connection loss handled\n");
