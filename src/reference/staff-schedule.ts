import { err, ok } from "../core/model.ts";
import type { Result, StaffedInterval } from "../core/model.ts";

const MINUTE_MS = 60_000;
const MAX_HORIZON_MS = 72 * 60 * MINUTE_MS;

// Sunday is 0. endMinute may be less than startMinute for an overnight window.
export type LocalStaffWindow = Readonly<{ weekday: number; startMinute: number; endMinute: number }>;
export type LocalStaffSchedule = Readonly<{
  timeZone: string;
  weekly: readonly LocalStaffWindow[];
  closedDates: readonly string[];
}>;
export type ScheduleFailure = Readonly<{ kind: "invalidSchedule"; field: "timeZone" | "weekly" | "closedDates" | "horizon" | "output" }>;

function instant(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}

function localMinute(formatter: Intl.DateTimeFormat, time: number): Readonly<{ date: string; weekday: number; minute: number }> {
  const parts = formatter.formatToParts(time);
  const part = (name: string) => parts.find(item => item.type === name)!.value;
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return { date, weekday: new Date(`${date}T00:00:00.000Z`).getUTCDay(),
    minute: Number(part("hour")) * 60 + Number(part("minute")) };
}

function staffed(windows: readonly LocalStaffWindow[], closed: ReadonlySet<string>, local: ReturnType<typeof localMinute>): boolean {
  if (closed.has(local.date)) return false;
  const previousWeekday = (local.weekday + 6) % 7;
  return windows.some(window => window.startMinute < window.endMinute
    ? window.weekday === local.weekday && window.startMinute <= local.minute && local.minute < window.endMinute
    : (window.weekday === local.weekday && local.minute >= window.startMinute) ||
      (window.weekday === previousWeekday && local.minute < window.endMinute));
}

/** Host-side expansion of local hours and holiday closures into a bounded call snapshot. */
export function expandStaffSchedule(schedule: LocalStaffSchedule, from: string, to: string): Result<readonly StaffedInterval[], ScheduleFailure> {
  const start = instant(from);
  const end = instant(to);
  if (start === undefined || end === undefined || start >= end || end - start > MAX_HORIZON_MS) return err({ kind: "invalidSchedule", field: "horizon" });
  if (!schedule || !Array.isArray(schedule.weekly) || schedule.weekly.length > 168 ||
      schedule.weekly.some(window => !window || !Number.isInteger(window.weekday) || window.weekday < 0 || window.weekday > 6 ||
        !Number.isInteger(window.startMinute) || window.startMinute < 0 || window.startMinute >= 1440 ||
        !Number.isInteger(window.endMinute) || window.endMinute <= 0 || window.endMinute > 1440 ||
        window.startMinute === window.endMinute)) return err({ kind: "invalidSchedule", field: "weekly" });
  if (!Array.isArray(schedule.closedDates) || schedule.closedDates.length > 90 || !schedule.closedDates.every(validDate)) {
    return err({ kind: "invalidSchedule", field: "closedDates" });
  }
  if (typeof schedule.timeZone !== "string" || !schedule.timeZone.trim()) return err({ kind: "invalidSchedule", field: "timeZone" });
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch { return err({ kind: "invalidSchedule", field: "timeZone" }); }

  const closed = new Set(schedule.closedDates);
  const intervals: StaffedInterval[] = [];
  let activeStart: number | undefined;
  let activeEnd = 0;
  for (let cursor = Math.floor(start / MINUTE_MS) * MINUTE_MS; cursor < end; cursor += MINUTE_MS) {
    const segmentStart = Math.max(cursor, start);
    const segmentEnd = Math.min(cursor + MINUTE_MS, end);
    if (staffed(schedule.weekly, closed, localMinute(formatter, cursor))) {
      if (activeStart === undefined) activeStart = segmentStart;
      activeEnd = segmentEnd;
    } else if (activeStart !== undefined) {
      intervals.push({ startsAt: new Date(activeStart).toISOString(), endsAt: new Date(activeEnd).toISOString() });
      activeStart = undefined;
      if (intervals.length > 512) return err({ kind: "invalidSchedule", field: "output" });
    }
  }
  if (activeStart !== undefined) intervals.push({ startsAt: new Date(activeStart).toISOString(), endsAt: new Date(activeEnd).toISOString() });
  return intervals.length > 512 ? err({ kind: "invalidSchedule", field: "output" }) : ok(intervals);
}
