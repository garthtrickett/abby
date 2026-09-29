const markerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validRecallMarker(value: unknown): value is string {
  return typeof value === "string" && markerPattern.test(value);
}

export function validRecallSummary(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 1_000 &&
    !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value);
}

export function validRecallDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Notes, including patient-specific request detail, exist only in Cliniko. */
export function formatRecallNote(marker: string, summary: string): string {
  return `Abby request ${marker}\n${summary}`;
}

export function matchesRecallMarker(notes: string | null, marker: string): boolean {
  return notes === marker || (typeof notes === "string" && notes.startsWith(`Abby request ${marker}\n`));
}
