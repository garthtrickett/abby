/** Time eligibility only. A due instant supplies no audience, DNC, recipient,
 * launch, patient, capacity or clinical permission and performs no I/O. */
export type OutboundContactSchedule = Readonly<{
  notBefore: string; expiresAt: string; timeZone: string;
  /** ISO weekdays of the local window's starting date: Monday1 through Sunday7. */
  weekdays: readonly number[];
  /** Canonical local HH:mm;24:00 is permitted only as the closing boundary.
   * An overnight window belongs to the weekday on which it opens. Both
   * occurrences of a repeated DST clock time use the same civil-time rule;
   * a missing local time has no dispatch instant. */
  opensAt: string; closesAt: string;
}>;
export type OutboundContactTime = Readonly<{ kind: "due" | "beforeSchedule" | "expired" | "quiet" | "invalid" }>;
const day = new Map([["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 7]]);
function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length !== 24) return undefined;
  const n = Date.parse(value); return Number.isFinite(n) && new Date(n).toISOString() === value ? n : undefined;
}
function minute(value: unknown, closing = false): number | undefined {
  if (closing && value === "24:00") return 1440;
  if (typeof value !== "string" || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) return undefined;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
const result = (kind: OutboundContactTime["kind"]): OutboundContactTime => Object.freeze({ kind });
export function outboundContactTime(schedule: OutboundContactSchedule, now: string): OutboundContactTime {
  try {
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule) ||
        Object.keys(schedule).sort().join(",") !== "closesAt,expiresAt,notBefore,opensAt,timeZone,weekdays") return result("invalid");
    const began = instant(schedule.notBefore), ends = instant(schedule.expiresAt), at = instant(now),
      opens = minute(schedule.opensAt), closes = minute(schedule.closesAt, true);
    if (began === undefined || ends === undefined || at === undefined || began >= ends || opens === undefined || closes === undefined || opens === closes ||
        typeof schedule.timeZone !== "string" || !schedule.timeZone || schedule.timeZone.length > 100 || schedule.timeZone.trim() !== schedule.timeZone ||
        !Array.isArray(schedule.weekdays) || schedule.weekdays.length < 1 || schedule.weekdays.length > 7 ||
        !schedule.weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7) || new Set(schedule.weekdays).size !== schedule.weekdays.length) return result("invalid");
    // Validate the timezone even outside the schedule; invalid policy must not
    // masquerade as a valid future/expired contact decision.
    const format = new Intl.DateTimeFormat("en-GB-u-ca-iso8601-nu-latn", { timeZone: schedule.timeZone,
      weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (at < began) return result("beforeSchedule");
    if (at >= ends) return result("expired");
    const parts = new Map(format.formatToParts(at).map(p => [p.type, p.value]));
    const weekday = day.get(parts.get("weekday") ?? ""), hour = Number(parts.get("hour")), minutes = Number(parts.get("minute"));
    if (!weekday || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) return result("invalid");
    const local = hour * 60 + minutes, overnight = closes < opens;
    if (overnight ? local < opens && local >= closes : local < opens || local >= closes) return result("quiet");
    const startingDay = overnight && local < closes ? (weekday === 1 ? 7 : weekday - 1) : weekday;
    return result(schedule.weekdays.includes(startingDay) ? "due" : "quiet");
  } catch { return result("invalid"); }
}
