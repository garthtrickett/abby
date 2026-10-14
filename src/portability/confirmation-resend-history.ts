/** Submission barriers, never recipient, appointment, caller proof or message content. */
export type ConfirmationResendArchiveRow = Readonly<{
  requestRef: string;
  ownerBinding: string;
  status: "possiblySent" | "accepted" | "unknown" | "definitiveUnsent";
  messageRef: string | null;
  createdAt: string;
  completedAt: string | null;
}>;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function instant(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Legacy absence is empty. A present row must match the exact non-patient contract. */
export function validConfirmationResendArchiveHistory(value: unknown): value is readonly ConfirmationResendArchiveRow[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== "completedAt,createdAt,messageRef,ownerBinding,requestRef,status" ||
        typeof row.requestRef !== "string" || !uuid.test(row.requestRef) || seen.has(row.requestRef) ||
        typeof row.ownerBinding !== "string" || !/^[a-f0-9]{64}$/.test(row.ownerBinding) || !instant(row.createdAt)) return false;
    if (row.status === "possiblySent") {
      if (row.messageRef !== null || row.completedAt !== null) return false;
    } else {
      if (!instant(row.completedAt) || row.completedAt < row.createdAt) return false;
      if (row.status === "accepted") {
        // Preserve a contradictory receipt too; recovery treats a mismatched UUID as unknown.
        if (typeof row.messageRef !== "string" || !uuid.test(row.messageRef)) return false;
      } else if (!["unknown", "definitiveUnsent"].includes(row.status) || row.messageRef !== null) return false;
    }
    seen.add(row.requestRef);
  }
  return true;
}
