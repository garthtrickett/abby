import { sql } from "kysely";
import type { Kysely, Transaction } from "kysely";
import type Database from "./generated/Database.ts";
import type { LocationScope } from "../core/model.ts";
import { validPatientCorrectionArchiveHistory } from "../portability/patient-correction-history.ts";
import type { ClinicPatientCorrectionArchiveRow } from "../portability/patient-correction-history.ts";

const base: ClinicPatientCorrectionArchiveRow = { version: 0, isHead: true, enabled: false,
  changedBy: null, previousEnabled: null, changedAt: null };
type Row = { clinic_id: string; version: number; enabled: boolean; changed_by: string | null;
  previous_enabled: boolean | null; changed_at: Date | null };

export async function readPatientCorrectionCarryover(db: Kysely<Database>, tenantId: string):
  Promise<readonly (ClinicPatientCorrectionArchiveRow & { sourceClinicId: string })[]> {
  const result = await sql<Row>`select clinic_id, version, enabled, changed_by, previous_enabled, changed_at
    from clinic_patient_correction_settings where tenant_id = ${tenantId} order by clinic_id, version`.execute(db);
  const heads = new Map(result.rows.map(row => [row.clinic_id, row.version]));
  const rows = result.rows.map(row => ({ sourceClinicId: row.clinic_id, version: row.version,
    isHead: heads.get(row.clinic_id) === row.version, enabled: row.enabled, changedBy: row.changed_by,
    previousEnabled: row.previous_enabled, changedAt: row.changed_at?.toISOString() ?? null }));
  for (const clinic of heads.keys()) {
    if (!validPatientCorrectionArchiveHistory(rows.filter(row => row.sourceClinicId === clinic)
      .map(({ sourceClinicId: _scope, ...row }) => row))) throw new Error("invalid patient correction history");
  }
  return rows;
}

export async function writePatientCorrectionCarryover(db: Transaction<Database>, scope: LocationScope,
  history: readonly ClinicPatientCorrectionArchiveRow[] | undefined, actor: string, importedAt: string): Promise<void> {
  if (!validPatientCorrectionArchiveHistory(history)) throw new Error("invalid patient correction history");
  const rows = history?.length ? [...history].sort((a, b) => a.version - b.version) : [base];
  const head = rows.find(row => row.isHead)!;
  if (head.enabled) rows.push({ version: head.version + 1, isHead: true, enabled: false,
    changedBy: actor, previousEnabled: true, changedAt: importedAt });
  for (const row of rows) await sql`insert into clinic_patient_correction_settings
    (tenant_id, clinic_id, version, enabled, changed_by, previous_enabled, changed_at)
    values (${scope.tenantId}, ${scope.clinicId}, ${row.version}, ${row.enabled}, ${row.changedBy},
      ${row.previousEnabled}, ${row.changedAt}::timestamptz)`.execute(db);
}

export async function reconcilePatientCorrectionCarryover(db: Transaction<Database>, scope: LocationScope,
  history: readonly ClinicPatientCorrectionArchiveRow[] | undefined, actor: string, importedAt: string): Promise<number | undefined> {
  if (!validPatientCorrectionArchiveHistory(history)) return undefined;
  const rows = history?.length ? [...history].sort((a, b) => a.version - b.version) : [base];
  const head = rows.find(row => row.isHead)!;
  if (head.enabled) rows.push({ version: head.version + 1, isHead: true, enabled: false,
    changedBy: actor, previousEnabled: true, changedAt: importedAt });
  const actual = (await sql<Row>`select version, enabled, changed_by, previous_enabled, changed_at
    from clinic_patient_correction_settings where tenant_id = ${scope.tenantId} and clinic_id = ${scope.clinicId}
    order by version`.execute(db)).rows;
  if (history === undefined && actual.length === 0) return 0; // Imports staged before this field existed used the implicit disabled default.
  if (actual.length !== rows.length) return undefined;
  if (rows.some((row, i) => { const found = actual[i]!;
    return found.version !== row.version || found.enabled !== row.enabled || found.changed_by !== row.changedBy ||
      found.previous_enabled !== row.previousEnabled || (found.changed_at?.toISOString() ?? null) !== row.changedAt;
  })) return undefined;
  return actual.length;
}
