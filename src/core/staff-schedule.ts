import { err, ok } from "./model.ts";
import type { ApprovedStaffSchedule, LocalStaffSchedule, LocalStaffWindow, LocationScope, Result, StaffedInterval } from "./model.ts";

const MINUTE_MS = 60_000;
const MAX_HORIZON_MS = 72 * 60 * MINUTE_MS;

export type { LocalStaffSchedule, LocalStaffWindow } from "./model.ts";
export type StaffedScheduleSnapshot = Readonly<{
  staffedCoverage: StaffedInterval;
  staffedIntervals: readonly StaffedInterval[];
}>;
export type ScheduleFailure = Readonly<{ kind: "invalidSchedule"; field: "timeZone" | "weekly" | "closedDates" | "horizon" | "output" }>;

export function validStaffScheduleApproval(value: unknown, scope: LocationScope, now?: string): value is ApprovedStaffSchedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const approval = value as Record<string, unknown>;
  const bound = approval.scope as Record<string, unknown> | undefined;
  const validRef = (ref: unknown) => typeof ref === "string" && !!ref.trim() && ref.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(ref);
  const from = typeof approval.effectiveFrom === "string" ? instant(approval.effectiveFrom) : undefined;
  const until = typeof approval.effectiveUntil === "string" ? instant(approval.effectiveUntil) : undefined;
  const current = now === undefined ? undefined : instant(now);
  return approval.approved === true && validRef(approval.version) && validRef(approval.ownerRef) &&
    from !== undefined && until !== undefined && from < until &&
    (now === undefined || (current !== undefined && from <= current && current < until)) &&
    !!bound && typeof bound === "object" && !Array.isArray(bound) &&
    bound.tenantId === scope.tenantId && bound.clinicId === scope.clinicId && bound.locationId === scope.locationId;
}

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
  const previousDate = new Date(Date.parse(`${local.date}T00:00:00.000Z`) - 24 * 60 * MINUTE_MS)
    .toISOString().slice(0, 10);
  return windows.some(window => window.startMinute < window.endMinute
    ? window.weekday === local.weekday && window.startMinute <= local.minute && local.minute < window.endMinute
    : (window.weekday === local.weekday && local.minute >= window.startMinute) ||
      (window.weekday === previousWeekday && local.minute < window.endMinute && !closed.has(previousDate)));
}

/** Host-side expansion of local hours and holiday closures into a bounded call snapshot. */
export function expandStaffSchedule(schedule: LocalStaffSchedule, from: string, to: string): Result<StaffedScheduleSnapshot, ScheduleFailure> {
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
  return intervals.length > 512 ? err({ kind: "invalidSchedule", field: "output" }) :
    ok({ staffedCoverage: { startsAt: from, endsAt: to }, staffedIntervals: intervals });
}
