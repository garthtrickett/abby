/** Convert an exact inbound keypad choice into a clinic-local calendar date. */
export function keypadAvailabilityDate(clinicDate: () => string, digit: string): string | undefined {
  if (digit !== "1" && digit !== "2") return undefined;
  let today: string;
  try { today = clinicDate(); } catch { return undefined; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return undefined;
  const date = new Date(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== today) return undefined;
  if (digit === "2") date.setUTCDate(date.getUTCDate() + 1);
  const selected = date.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(selected) ? selected : undefined;
}
