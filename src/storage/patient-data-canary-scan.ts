import { sql } from "kysely";
import type { Kysely } from "kysely";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type Database from "./generated/Database.ts";

export type PatientDataCanary = Readonly<{ label: string; value: string }>;
export type PatientDataCanaryHit = Readonly<{ label: string; table: string; column: string }>;
export type PatientDataCanaryFailure = Readonly<{ kind: "invalidInput" | "storageFailure" }>;

/** Diagnostic for a disposable standalone database. It returns locations, never stored values. */
export async function scanPatientDataCanaries(db: Kysely<Database>, canaries: readonly PatientDataCanary[]):
  Promise<Result<readonly PatientDataCanaryHit[], PatientDataCanaryFailure>> {
  if (!Array.isArray(canaries) || canaries.length < 1 || canaries.length > 12 ||
      canaries.some(canary => !canary || typeof canary.label !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(canary.label) || typeof canary.value !== "string" ||
        canary.value.length < 4 || canary.value.length > 256) ||
      new Set(canaries.map(canary => canary.label)).size !== canaries.length) return err({ kind: "invalidInput" });
  try {
    return await db.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      const columns = await sql<{ table_name: string; column_name: string; data_type: string }>`
        select c.table_name, c.column_name, c.data_type
        from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = current_schema() and t.table_type = 'BASE TABLE'
        order by c.table_name, c.ordinal_position`.execute(trx);
      const hits: PatientDataCanaryHit[] = [];
      for (const column of columns.rows) {
        const table = sql.ref(column.table_name);
        const field = sql.ref(column.column_name);
        for (const canary of canaries) {
          const found = column.data_type === "bytea"
            ? await sql<{ hit: boolean }>`select exists(select 1 from ${table}
                where position(${canary.value} in encode(${field}, 'escape')) > 0) as hit`.execute(trx)
            : await sql<{ hit: boolean }>`select exists(select 1 from ${table}
                where position(${canary.value} in ${field}::text) > 0) as hit`.execute(trx);
          if (found.rows[0]?.hit) hits.push({ label: canary.label, table: column.table_name, column: column.column_name });
        }
      }
      return ok(hits);
    });
  } catch { return err({ kind: "storageFailure" }); }
}
