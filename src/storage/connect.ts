import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type Database from "./generated/Database.ts";

export function connectPostgres(connectionString: string): Kysely<Database> {
  const pool = new Pool({ connectionString, max: 4, allowExitOnIdle: true });
  // pg emits an error for an idle client when PostgreSQL disappears. Queries and
  // health checks still fail normally; an unhandled pool event must not kill a call process.
  pool.on("error", () => {});
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
