/** Clinic-local start constraints never change service, practitioner, duration,
 * policy horizon or patient authority. Legacy single clock windows retain
 * their exact half-open semantics; compound clauses are OR, fields are AND. */
export type BookingClockWindow = Readonly<{ startMinute: number; endMinute: number; startInclusive: boolean }>;
export type BookingSearchClause = Readonly<{ weekdays?: readonly number[]; dates?: readonly string[]; window?: BookingClockWindow }>;
export type BookingSearchWindow = BookingClockWindow | Readonly<{ anyOf: readonly BookingSearchClause[] }>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function validClock(value: unknown): value is BookingClockWindow {
  if (!object(value)) return false;
  return Object.keys(value).sort().join(",") === "endMinute,startInclusive,startMinute" &&
    Number.isSafeInteger(value.startMinute) && Number.isSafeInteger(value.endMinute) &&
    Number(value.startMinute) >= 0 && Number(value.endMinute) <= 1440 && Number(value.startMinute) < Number(value.endMinute) &&
    typeof value.startInclusive === "boolean";
}
function validClause(value: unknown): value is BookingSearchClause {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !["weekdays", "dates", "window"].includes(key))) return false;
  const days = value.weekdays, dates = value.dates;
  return (days === undefined || Array.isArray(days) && days.length > 0 && days.length <= 7 &&
    days.every(day => Number.isInteger(day) && day >= 0 && day <= 6) && new Set(days).size === days.length) &&
    (dates === undefined || Array.isArray(dates) && dates.length > 0 && dates.length <= 7 && new Set(dates).size === dates.length &&
      dates.every(date => typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date)) &&
    (value.window === undefined || validClock(value.window)) && (days !== undefined || dates !== undefined || value.window !== undefined);
}
export function validBookingSearchWindow(value: unknown): value is BookingSearchWindow {
  return validClock(value) || object(value) && Object.keys(value).join(",") === "anyOf" && Array.isArray(value.anyOf) &&
    value.anyOf.length > 0 && value.anyOf.length <= 8 && value.anyOf.every(validClause);
}
/** Copy nested caller input before asynchronous work; no array remains shared. */
export function copyBookingSearchWindow(value: BookingSearchWindow): BookingSearchWindow {
  const clock = (w: BookingClockWindow) => Object.freeze({ startMinute: w.startMinute, endMinute: w.endMinute, startInclusive: w.startInclusive });
  if (!("anyOf" in value)) return clock(value);
  return Object.freeze({ anyOf: Object.freeze(value.anyOf.map(clause => Object.freeze({
    ...(clause.weekdays ? { weekdays: Object.freeze([...clause.weekdays].sort()) } : {}),
    ...(clause.dates ? { dates: Object.freeze([...clause.dates].sort()) } : {}),
    ...(clause.window ? { window: clock(clause.window) } : {}),
  }))) });
}
export function sameBookingSearchWindow(left: unknown, right: unknown): boolean {
  return validBookingSearchWindow(left) && validBookingSearchWindow(right) && JSON.stringify(copyBookingSearchWindow(left)) === JSON.stringify(copyBookingSearchWindow(right));
}
export function matchesBookingSearchWindow(startsAt: string, timeZone: string, window?: BookingSearchWindow): boolean {
  if (!window) return true;
  if (!validBookingSearchWindow(window)) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
      hour: "numeric", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(startsAt));
    const field = (name: string) => parts.find(part => part.type === name)?.value;
    const minute = Number(field("hour")) * 60 + Number(field("minute")) + Number(field("second")) / 60;
    const date = `${field("year")}-${field("month")}-${field("day")}`, weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(field("weekday")!);
    const clock = (w: BookingClockWindow) => (w.startInclusive ? minute >= w.startMinute : minute > w.startMinute) && minute < w.endMinute;
    return "anyOf" in window ? window.anyOf.some(clause => (!clause.weekdays || clause.weekdays.includes(weekday)) &&
      (!clause.dates || clause.dates.includes(date)) && (!clause.window || clock(clause.window))) : clock(window);
  } catch { return false; }
}
/** Add a display/navigation bound without dropping any compound branch. */
export function intersectBookingSearchWindow(original: BookingSearchWindow | null, bound: BookingClockWindow): BookingSearchWindow | undefined {
  const intersect = (a: BookingClockWindow): BookingClockWindow | undefined => {
    const startMinute = Math.max(a.startMinute, bound.startMinute), endMinute = Math.min(a.endMinute, bound.endMinute);
    return startMinute < endMinute ? { startMinute, endMinute, startInclusive: (a.startMinute !== startMinute || a.startInclusive) &&
      (bound.startMinute !== startMinute || bound.startInclusive) } : undefined;
  };
  if (!original) return copyBookingSearchWindow(bound);
  if (!("anyOf" in original)) { const result = intersect(original); return result ? copyBookingSearchWindow(result) : undefined; }
  const anyOf = original.anyOf.flatMap(clause => { const window = clause.window ? intersect(clause.window) : bound; return window ? [{ ...clause, window }] : []; });
  return anyOf.length ? copyBookingSearchWindow({ anyOf }) : undefined;
}
export function bookingSearchWindowText(window: BookingSearchWindow): string {
  const clock = (minute: number) => minute === 1440 ? "midnight" : `${Math.floor(minute / 60) % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${minute < 720 ? "am" : "pm"}`;
  const clockText = (w: BookingClockWindow) => w.startMinute === 0 && w.startInclusive ? `before ${clock(w.endMinute)}` :
    `${w.startInclusive ? "from" : "after"} ${clock(w.startMinute)}${w.endMinute === 1440 ? "" : ` and before ${clock(w.endMinute)}`}`;
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return "anyOf" in window ? window.anyOf.map(clause => [clause.weekdays ? `on ${clause.weekdays.map(day => weekdays[day]).join(" or ")}` : "",
    clause.dates ? `on ${clause.dates.join(" or ")}` : "", clause.window ? clockText(clause.window) : ""].filter(Boolean).join(" and ")).join("; or ") : clockText(window);
}
