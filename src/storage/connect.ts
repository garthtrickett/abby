import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type Database from "./generated/Database.ts";

export function connectPostgres(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 4, allowExitOnIdle: true }) }),
  });
}
