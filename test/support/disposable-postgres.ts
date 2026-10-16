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

/** Each owner receives migrated PostgreSQL and a private socket. Never infer a
 * database from ambient credentials or a default localhost connection. */
export async function createDisposablePostgres(): Promise<Readonly<{
  db: ReturnType<typeof connectPostgres>; connectionString: string; close(): Promise<void>;
}>> {
  const folder = await mkdtemp(join(tmpdir(), "abby-browser-pg-"));
  const socket = join(folder, "socket");
  let container: string | undefined;
  let db: ReturnType<typeof connectPostgres> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const failures: unknown[] = [];
    try { await db?.destroy(); } catch (error) { failures.push(error); }
    try { if (container) await docker("stop", container); } catch (error) { failures.push(error); }
    try { await rm(folder, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "PostgreSQL cleanup failed");
  })();
  try {
    // The container user may write the socket directory; its parent remains owner-only on the host.
    await mkdir(socket, { mode: 0o777 }); await chmod(socket, 0o777);
    container = await docker("run", "--rm", "-d", "--network", "none", "--mount",
      `type=bind,source=${socket},target=/tmp/abby-browser-socket`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
      "--label", "abby.phase0.probe=true", "postgres:17-alpine", "postgres", "-c", "listen_addresses=",
      "-c", "unix_socket_directories=/var/run/postgresql,/tmp/abby-browser-socket");
    const connectionString = `postgresql://postgres@localhost:5432/postgres?host=${encodeURIComponent(socket)}`;
    db = connectPostgres(connectionString);
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        // The image starts a temporary socket server during init; only migrate against its final server.
        if (await docker("exec", container, "cat", "/proc/1/comm") !== "postgres") throw new Error("PostgreSQL is initializing");
        await sql`select 1`.execute(db); break;
      }
      catch { if (Date.now() >= deadline) throw new Error("disposable PostgreSQL did not become ready"); await delay(50); }
    }
    await migrate(db); return { db, connectionString, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "PostgreSQL setup or cleanup failed"); }
    throw error;
  }
}

/** Each case owns fresh PostgreSQL and a private socket; Docker leaves the browser's host network alone. */
export async function withDisposablePostgres(run: (db: ReturnType<typeof connectPostgres>, connectionString: string) => Promise<void>): Promise<void> {
  const resource = await createDisposablePostgres();
  let originalFailure: unknown;
  try { await run(resource.db, resource.connectionString); }
  catch (error) { originalFailure = error; throw error; }
  finally {
    try { await resource.close(); }
    catch (cleanup) {
      if (originalFailure !== undefined) throw new AggregateError([originalFailure, cleanup], "PostgreSQL test or cleanup failed");
      throw cleanup;
    }
  }
}
