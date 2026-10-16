export type ClinicPatientCorrectionArchiveRow = Readonly<{
  version: number; isHead: boolean; enabled: boolean; changedBy: string | null;
  previousEnabled: boolean | null; changedAt: string | null;
}>;

/** Legacy absence is disabled version zero. Present history contains public setting metadata only. */
export function validPatientCorrectionArchiveHistory(value: unknown): value is readonly ClinicPatientCorrectionArchiveRow[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const fields = "changedAt,changedBy,enabled,isHead,previousEnabled,version";
  const rows: ClinicPatientCorrectionArchiveRow[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join(",") !== fields ||
        !Number.isSafeInteger(row.version) || row.version < 0 || row.version >= 2_147_483_647 ||
        typeof row.isHead !== "boolean" || typeof row.enabled !== "boolean") return false;
    rows.push(row);
  }
  rows.sort((a, b) => a.version - b.version);
  for (const [index, row] of rows.entries()) {
    if (row.version !== index || row.isHead !== (index === rows.length - 1)) return false;
    if (index === 0) {
      if (row.enabled || row.changedBy !== null || row.previousEnabled !== null || row.changedAt !== null) return false;
    } else if (typeof row.changedBy !== "string" || !row.changedBy.trim() || row.changedBy.length > 256 ||
        /[\p{Cc}\p{Cf}]/u.test(row.changedBy) || row.previousEnabled !== rows[index - 1]!.enabled ||
        typeof row.changedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.changedAt) ||
        !Number.isFinite(Date.parse(row.changedAt))) return false;
  }
  return true;
}
