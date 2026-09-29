import { createHash } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type Database from "./generated/Database.ts";
import type { PatientPhoneClinicScope } from "./postgres-patient-phone-index.ts";

export type PhoneRefreshGuardFailure = Readonly<{ kind: "invalidInput" | "storageFailure" }>;
export type PhoneRefreshGuardResult<T> =
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "ran"; value: T }>;

function lockKey(scope: PatientPhoneClinicScope): string {
  const digest = createHash("sha256").update(JSON.stringify(["abby-phone-refresh-v1", scope.tenantId, scope.clinicId])).digest();
  return digest.readBigInt64BE(0).toString();
}

/** The lock and every guarded write use one pinned PostgreSQL session. */
export class PostgresPhoneRefreshGuard {
  private readonly connectionString: string;

  constructor(connectionString: string) { this.connectionString = connectionString; }

  async run<T>(scope: PatientPhoneClinicScope, task: (db: Kysely<Database>) => Promise<T>):
    Promise<Result<PhoneRefreshGuardResult<T>, PhoneRefreshGuardFailure>> {
    if (!scope || [scope.tenantId, scope.clinicId].some(value =>
      typeof value !== "string" || !value.trim() || value.length > 256) || typeof task !== "function") {
      return err({ kind: "invalidInput" });
    }
    const pool = new Pool({ connectionString: this.connectionString, max: 1, allowExitOnIdle: true });
    // A checked-out pg client can emit an error while a Cliniko read is pending.
    pool.on("acquire", (client: PoolClient) => { client.on("error", () => {}); });
    pool.on("error", () => {});
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const key = lockKey(scope);
    try {
      return await db.connection().execute(async owner => {
        const claimed = await sql<{ acquired: boolean }>`select pg_try_advisory_lock(${key}::bigint) as acquired`.execute(owner);
        if (claimed.rows[0]?.acquired !== true) return ok({ kind: "busy" });
        try {
          const value = await task(owner);
          return ok({ kind: "ran", value });
        } finally {
          const released = await sql<{ released: boolean }>`select pg_advisory_unlock(${key}::bigint) as released`.execute(owner);
          if (released.rows[0]?.released !== true) throw new Error("phone refresh lock lost");
        }
      });
    } catch {
      return err({ kind: "storageFailure" });
    } finally {
      try { await db.destroy(); } catch { /* a dead session releases its lock server-side */ }
    }
  }
}
