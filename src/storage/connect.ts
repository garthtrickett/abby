import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type Database from "./generated/Database.ts";

export function connectPostgres(connectionString: string): Kysely<Database> {
  const pool = new Pool({ connectionString, max: 4, allowExitOnIdle: true });
  // pg emits an error for an idle client when PostgreSQL disappears. Queries and
  // health checks still fail normally; an unhandled pool event must not kill a call process.
  pool.on("error", () => {});
  // pg-pool removes its idle-client error listener at checkout. A terminated
  // checked-out connection can then emit an unhandled error before Kysely uses
  // or releases it. Keep one listener per client; the query still rejects.
  const guardedClients = new WeakSet<object>();
  pool.on("acquire", client => {
    if (guardedClients.has(client)) return;
    guardedClients.add(client);
    client.on("error", () => {});
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
