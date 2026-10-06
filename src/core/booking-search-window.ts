/** Clinic-local appointment start-time constraint. It never changes service,
 * practitioner, duration, policy horizon or patient authority. */
export type BookingSearchWindow = Readonly<{ startMinute: number; endMinute: number; startInclusive: boolean }>;
export function validBookingSearchWindow(value: unknown): value is BookingSearchWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const w = value as Record<string, unknown>;
  return Object.keys(w).sort().join(",") === "endMinute,startInclusive,startMinute" &&
    Number.isSafeInteger(w.startMinute) && Number.isSafeInteger(w.endMinute) &&
    Number(w.startMinute) >= 0 && Number(w.endMinute) <= 1440 && Number(w.startMinute) < Number(w.endMinute) &&
    typeof w.startInclusive === "boolean";
}
export function matchesBookingSearchWindow(startsAt: string, timeZone: string, window?: BookingSearchWindow): boolean {
  if (!window) return true;
  if (!validBookingSearchWindow(window)) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(startsAt));
    const field = (name: string) => Number(parts.find(part => part.type === name)?.value);
    const minute = field("hour") * 60 + field("minute") + field("second") / 60;
    return (window.startInclusive ? minute >= window.startMinute : minute > window.startMinute) && minute < window.endMinute;
  } catch { return false; }
}
export function bookingSearchWindowText(window: BookingSearchWindow): string {
  const clock = (minute: number) => minute === 1440 ? "midnight" :
    `${Math.floor(minute / 60) % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${minute < 720 ? "am" : "pm"}`;
  return window.startMinute === 0 && window.startInclusive ? `before ${clock(window.endMinute)}` :
    `${window.startInclusive ? "from" : "after"} ${clock(window.startMinute)}${window.endMinute === 1440 ? "" : ` and before ${clock(window.endMinute)}`}`;
}
