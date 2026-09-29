import { createHash } from "node:crypto";
import { Client } from "pg";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { PatientPhoneClinicScope } from "./postgres-patient-phone-index.ts";

export type PhoneRefreshGuardFailure = Readonly<{ kind: "invalidInput" | "storageFailure" }>;
export type PhoneRefreshGuardResult<T> =
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "ran"; value: T }>;

function lockKey(scope: PatientPhoneClinicScope): string {
  const digest = createHash("sha256").update(JSON.stringify(["abby-phone-refresh-v1", scope.tenantId, scope.clinicId])).digest();
  return digest.readBigInt64BE(0).toString();
}

/** One PostgreSQL session owns a clinic refresh. The session is held outside the ledger pool. */
export class PostgresPhoneRefreshGuard {
  private readonly connectionString: string;

  constructor(connectionString: string) { this.connectionString = connectionString; }

  async run<T>(scope: PatientPhoneClinicScope, task: () => Promise<T>):
    Promise<Result<PhoneRefreshGuardResult<T>, PhoneRefreshGuardFailure>> {
    if (!scope || [scope.tenantId, scope.clinicId].some(value =>
      typeof value !== "string" || !value.trim() || value.length > 256) || typeof task !== "function") {
      return err({ kind: "invalidInput" });
    }
    const client = new Client({ connectionString: this.connectionString });
    // pg emits an error event when a held session dies while the task is awaiting Cliniko.
    client.on("error", () => {});
    const key = lockKey(scope);
    try {
      await client.connect();
      const claimed = await client.query<{ acquired: boolean }>("select pg_try_advisory_lock($1::bigint) as acquired", [key]);
      if (claimed.rows[0]?.acquired !== true) return ok({ kind: "busy" });
      try {
        const value = await task();
        return ok({ kind: "ran", value });
      } finally {
        const released = await client.query<{ released: boolean }>("select pg_advisory_unlock($1::bigint) as released", [key]);
        if (released.rows[0]?.released !== true) throw new Error("phone refresh lock lost");
      }
    } catch {
      return err({ kind: "storageFailure" });
    } finally {
      try { await client.end(); } catch { /* a dead session releases its lock server-side */ }
    }
  }
}
