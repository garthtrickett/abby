import { clinicDayStartUtc } from "../standalone/clinic-clock.ts";

export type CalendarInterval = Readonly<{ start: number; end: number }>;
export type DailyRoster = Readonly<{ dayOfWeek: number; intervals: readonly Readonly<{ startMinute: number; endMinute: number }>[] }>;
export type RosterSearchPlan = Readonly<{ mode: "roster"; maxSearchDays: number; slotIntervalMinutes: number;
  weekdayOrigin: "sunday" | "monday"; busyScope: "practitionerAllBusinesses";
  /** Each approval uses only returned native instants, never inferred repeat dates. */
  busyRecurrence?: "nativeOccurrences";
  openingRecurrence?: "nativeOccurrences" }>;

export function validRosterSearchPlan(value: unknown): value is RosterSearchPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as RosterSearchPlan;
  const keys = Object.keys(value).filter(key => !["busyRecurrence", "openingRecurrence"].includes(key)).sort().join(",");
  if (keys !== "busyScope,maxSearchDays,mode,slotIntervalMinutes,weekdayOrigin") return false;
  for (const key of ["busyRecurrence", "openingRecurrence"] as const) {
    if (Object.hasOwn(value, key) ? p[key] !== "nativeOccurrences" : p[key] !== undefined) return false;
  }
  return p.mode === "roster" && Number.isSafeInteger(p.maxSearchDays) && p.maxSearchDays >= 1 && p.maxSearchDays <= 90 &&
    Number.isSafeInteger(p.slotIntervalMinutes) && p.slotIntervalMinutes >= 1 && p.slotIntervalMinutes <= 60 &&
    ["sunday", "monday"].includes(p.weekdayOrigin) && p.busyScope === "practitionerAllBusinesses";
}
export function calendarDate(value: string): number | undefined {
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? at : undefined;
}
export function calendarInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  if (calendarDate(value.slice(0, 10)) === undefined) return undefined;
  const at = Date.parse(value); return Number.isFinite(at) ? at : undefined;
}
function merge(intervals: readonly CalendarInterval[]): CalendarInterval[] {
  const result: { start: number; end: number }[] = [];
  for (const value of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && value.start <= last.end) last.end = Math.max(last.end, value.end);
    else result.push({ ...value });
  }
  return result;
}
/** Calendar arithmetic retains only roster clocks and busy intervals. UTC
 * stepping on DST days includes both real folds and never invents gap times. */
export function rosterStarts(input: Readonly<{ from: string; to: string; timeZone: string; durationMinutes: number;
  plan: RosterSearchPlan; daily: readonly DailyRoster[]; extra: readonly CalendarInterval[]; busy: readonly CalendarInterval[];
  signal: AbortSignal }>): string[] {
  const first = calendarDate(input.from), last = calendarDate(input.to);
  if (first === undefined || last === undefined || last < first || (last - first) / 86_400_000 + 1 > input.plan.maxSearchDays ||
      !validRosterSearchPlan(input.plan) || !Number.isSafeInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 480 ||
      !Array.isArray(input.daily) || !Array.isArray(input.extra) || !Array.isArray(input.busy) ||
      input.daily.some(row => !Number.isInteger(row.dayOfWeek) || row.dayOfWeek < 0 || row.dayOfWeek > (input.plan.weekdayOrigin === "sunday" ? 7 : 6) || !Array.isArray(row.intervals) ||
        row.intervals.some((w: DailyRoster["intervals"][number]) => !Number.isInteger(w.startMinute) || !Number.isInteger(w.endMinute) || w.startMinute < 0 || w.endMinute > 1440 || w.startMinute >= w.endMinute)) ||
      [...input.extra, ...input.busy].some(i => !Number.isFinite(i.start) || !Number.isFinite(i.end) || i.start >= i.end)) throw new TypeError("invalid roster search");
  const openings: CalendarInterval[] = [], step = 60_000;
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: input.timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h23" });
  for (let day = first; day <= last + 86_400_000; day += 86_400_000) {
    if (input.signal.aborted) throw new Error("roster search aborted");
    const date = new Date(day).toISOString().slice(0, 10), next = new Date(day + 86_400_000).toISOString().slice(0, 10);
    const start = Date.parse(clinicDayStartUtc(input.timeZone, date)), end = Date.parse(clinicDayStartUtc(input.timeZone, next));
    const weekday = (new Date(day).getUTCDay() + (input.plan.weekdayOrigin === "monday" ? 6 : 0)) % 7;
    const windows = input.daily.filter(row => row.dayOfWeek === weekday || input.plan.weekdayOrigin === "sunday" && row.dayOfWeek === 7 && weekday === 0).flatMap(row => row.intervals);
    if (!windows.length) continue;
    if (end - start === 86_400_000) {
      for (const window of windows) openings.push({ start: start + window.startMinute * step, end: start + window.endMinute * step });
    } else {
      let open: number | undefined;
      for (let at = start; at < end; at += step) {
        const parts = Object.fromEntries(clock.formatToParts(new Date(at)).map(part => [part.type, part.value]));
        const minute = Number(parts.hour) * 60 + Number(parts.minute);
        const available = windows.some(w => minute >= w.startMinute && minute < w.endMinute);
        if (available) open ??= at;
        else if (open !== undefined) { openings.push({ start: open, end: at }); open = undefined; }
      }
      if (open !== undefined) openings.push({ start: open, end });
    }
  }
  const lower = Date.parse(clinicDayStartUtc(input.timeZone, input.from));
  const upper = Date.parse(clinicDayStartUtc(input.timeZone, new Date(last + 86_400_000).toISOString().slice(0, 10)));
  const active = merge([...openings, ...input.extra]).filter(i => i.start < upper && i.end > lower);
  const busy = merge(input.busy), result: string[] = [], duration = input.durationMinutes * step;
  const grid = input.plan.slotIntervalMinutes * step;
  for (const opening of active) for (let at = opening.start + Math.max(0, Math.ceil((lower - opening.start) / grid)) * grid;
    at < upper && at + duration <= opening.end; at += grid) {
    if (input.signal.aborted) throw new Error("roster search aborted");
    if (!busy.some(b => at < b.end && at + duration > b.start)) result.push(new Date(at).toISOString());
  }
  return result;
}
