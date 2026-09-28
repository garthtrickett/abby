import type { CallPolicy, StaffedInterval } from "./model.ts";

function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return undefined;
  return parsed;
}

// The host expands local hours, holidays, and timezone rules into UTC intervals
// before admitting the call. A missing or malformed snapshot never permits transfer.
export function staffedForTransfer(policy: CallPolicy, now: string): boolean {
  const current = instant(now);
  const intervals = policy.staffedIntervals;
  if (current === undefined || !Array.isArray(intervals) || intervals.length === 0 || intervals.length > 512) return false;
  let open = false;
  for (const interval of intervals as StaffedInterval[]) {
    if (!interval || typeof interval !== "object") return false;
    const start = instant(interval.startsAt);
    const end = instant(interval.endsAt);
    if (start === undefined || end === undefined || start >= end) return false;
    if (start <= current && current < end) open = true;
  }
  return open;
}
