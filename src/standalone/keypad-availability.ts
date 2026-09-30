export type KeypadAvailabilityRange = Readonly<{ from: string; to: string }>;

/** A null result means an intentionally disabled option; undefined means the clinic clock failed. */
export function keypadAvailabilityRange(clinicDate: () => string, digit: string,
                                        sevenDayApproved: boolean): KeypadAvailabilityRange | null | undefined {
  if (digit === "3" && !sevenDayApproved) return null;
  if (digit !== "1" && digit !== "2" && digit !== "3") return null;
  let today: string;
  try { today = clinicDate(); } catch { return undefined; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return undefined;
  const date = new Date(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== today) return undefined;
  if (digit === "2") date.setUTCDate(date.getUTCDate() + 1);
  const from = date.toISOString().slice(0, 10);
  if (digit === "3") date.setUTCDate(date.getUTCDate() + 6);
  const to = date.toISOString().slice(0, 10);
  return { from, to };
}

/** Kept for existing callers that request only one clinic-local date. */
export function keypadAvailabilityDate(clinicDate: () => string, digit: string): string | undefined {
  const range = keypadAvailabilityRange(clinicDate, digit, false);
  return range?.from;
}
