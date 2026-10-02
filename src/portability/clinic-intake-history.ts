export type ClinicIntakeArchiveRow = Readonly<{
  version: number;
  isHead: boolean;
  enabled: boolean;
  changedBy: string | null;
  previousEnabled: boolean | null;
  changedAt: string | null;
}>;

/** Legacy absence means disabled version zero. Present history must be complete and public-only. */
export function validClinicIntakeArchiveHistory(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const fields = ["version", "isHead", "enabled", "changedBy", "previousEnabled", "changedAt"].sort().join(",");
  const rows: ClinicIntakeArchiveRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== fields || !Number.isSafeInteger(entry.version) || entry.version < 0 ||
        typeof entry.isHead !== "boolean" || typeof entry.enabled !== "boolean") return false;
    rows.push(entry as ClinicIntakeArchiveRow);
  }
  rows.sort((left, right) => left.version - right.version);
  for (const [index, row] of rows.entries()) {
    if (row.version !== index || row.isHead !== (index === rows.length - 1)) return false;
    if (index === 0) {
      if (row.enabled || row.changedBy !== null || row.previousEnabled !== null || row.changedAt !== null) return false;
    } else if (typeof row.changedBy !== "string" || !row.changedBy.trim() || row.changedBy.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(row.changedBy) || row.previousEnabled !== rows[index - 1]!.enabled ||
        typeof row.changedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.changedAt) ||
        !Number.isFinite(Date.parse(row.changedAt))) return false;
  }
  return true;
}
