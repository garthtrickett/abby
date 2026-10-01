import { fileURLToPath } from "node:url";
import { connectPostgres } from "../src/storage/connect.ts";
import { PostgresOperationalCounters } from "../src/storage/postgres-operational-counters.ts";

/** Run from a scheduler with owner-only DATABASE_URL; emits no clinic or patient detail. */
export async function pruneVoiceOperations(connectionString: string): Promise<void> {
  if (!connectionString) throw new Error("database unavailable");
  const db = connectPostgres(connectionString);
  try { await new PostgresOperationalCounters(db).pruneExpired(); }
  finally { await db.destroy(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { await pruneVoiceOperations(process.env.DATABASE_URL ?? ""); }
  catch {
    process.stderr.write("operational retention unavailable\n");
    process.exitCode = 1;
  }
}
