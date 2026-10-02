import type { LocalStaffWindow } from "../../core/model.ts";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function minute(text: string, allowEndOfDay: boolean): number | undefined {
  const match = /^(\d\d):(\d\d)$/.exec(text);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && (!allowEndOfDay || minute !== 0))) return undefined;
  return hour * 60 + minute;
}

/** One clinic-local window per line, for example Mon 09:00-17:00. */
export function parseWeeklyHours(text: string): readonly LocalStaffWindow[] | undefined {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 168) return undefined;
  const windows: LocalStaffWindow[] = [];
  for (const line of lines) {
    const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d\d:\d\d)-(\d\d:\d\d)$/i.exec(line);
    if (!match) return undefined;
    const weekday = weekdays.findIndex(day => day.toLowerCase() === match[1]!.toLowerCase());
    const startMinute = minute(match[2]!, false);
    const endMinute = minute(match[3]!, true);
    if (weekday < 0 || startMinute === undefined || endMinute === undefined ||
        endMinute === 0 || startMinute === endMinute) return undefined;
    windows.push({ weekday, startMinute, endMinute });
  }
  return windows;
}

export function formatWeeklyHours(windows: readonly LocalStaffWindow[]): string {
  const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return windows.map(window => `${weekdays[window.weekday] ?? "?"} ${clock(window.startMinute)}-${clock(window.endMinute)}`).join("\n");
}
