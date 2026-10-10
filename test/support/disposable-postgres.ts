import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { connectPostgres } from "../../src/storage/connect.ts";
import { migrate } from "../../src/storage/migrate.ts";

const execute = promisify(execFile);
const docker = async (...args: string[]) => (await execute("docker", args, { timeout: 10_000, maxBuffer: 65_536 })).stdout.trim();

/** Each case owns fresh PostgreSQL and a private socket; Docker leaves the browser's host network alone. */
export async function withDisposablePostgres(run: (db: ReturnType<typeof connectPostgres>) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), "abby-browser-pg-"));
  const socket = join(folder, "socket");
  let container: string | undefined;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let originalFailure: unknown;
  try {
    // The container user may write the socket directory; its parent remains owner-only on the host.
    await mkdir(socket, { mode: 0o777 }); await chmod(socket, 0o777);
    container = await docker("run", "--rm", "-d", "--network", "none", "--mount",
      `type=bind,source=${socket},target=/tmp/abby-browser-socket`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
      "--label", "abby.phase0.probe=true", "postgres:17-alpine", "postgres", "-c", "listen_addresses=",
      "-c", "unix_socket_directories=/var/run/postgresql,/tmp/abby-browser-socket");
    db = connectPostgres(`postgresql://postgres@localhost:5432/postgres?host=${encodeURIComponent(socket)}`);
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        // The image starts a temporary socket server during init; only migrate against its final server.
        if (await docker("exec", container, "cat", "/proc/1/comm") !== "postgres") throw new Error("PostgreSQL is initializing");
        await sql`select 1`.execute(db); break;
      }
      catch { if (Date.now() >= deadline) throw new Error("disposable PostgreSQL did not become ready"); await delay(50); }
    }
    await migrate(db); await run(db);
  } catch (error) { originalFailure = error; throw error; }
  finally {
    const cleanupFailures: unknown[] = [];
    try { await db?.destroy(); } catch (error) { cleanupFailures.push(error); }
    try { if (container) await docker("stop", container); } catch (error) { cleanupFailures.push(error); }
    try { await rm(folder, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) {
      if (originalFailure !== undefined) cleanupFailures.unshift(originalFailure);
      throw new AggregateError(cleanupFailures, "PostgreSQL test or cleanup failed");
    }
  }
}
