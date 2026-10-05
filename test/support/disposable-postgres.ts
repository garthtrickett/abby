import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";

const execute = promisify(execFile);
const docker = async (...args: string[]) => (await execute("docker", args, { timeout: 10_000, maxBuffer: 65_536 })).stdout.trim();

/** A browser case owns a fresh PostgreSQL container; never reads DATABASE_URL or another clinic's database. */
export async function withDisposablePostgres(run: (db: ReturnType<typeof connectPostgres>) => Promise<void>): Promise<void> {
  const container = await docker("run", "--rm", "-d", "-p", "127.0.0.1::5432", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "--label", "abby.phase0.probe=true", "postgres:17-alpine");
  let db: ReturnType<typeof connectPostgres> | undefined;
  let originalFailure: unknown;
  try {
    const mapping = await docker("port", container, "5432/tcp"), port = mapping.match(/^127\.0\.0\.1:([0-9]+)$/)?.[1];
    if (!port || Number(port) < 1 || Number(port) > 65_535) throw new Error("disposable PostgreSQL listener unavailable");
    db = connectPostgres(`postgresql://postgres@127.0.0.1:${port}/postgres`);
    const deadline = Date.now() + 15_000;
    while (true) {
      try { await sql`select 1`.execute(db); break; }
      catch { if (Date.now() >= deadline) throw new Error("disposable PostgreSQL did not become ready"); await delay(50); }
    }
    await migrate(db); await run(db);
  } catch (error) { originalFailure = error; throw error; }
  finally {
    try { try { await db?.destroy(); } finally { await docker("stop", container); } }
    catch (cleanupFailure) {
      if (originalFailure !== undefined) throw new AggregateError([originalFailure, cleanupFailure], "PostgreSQL test and cleanup failed");
      throw cleanupFailure;
    }
  }
}
