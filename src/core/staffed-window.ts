import type { CallPolicy, StaffedInterval } from "./model.ts";

function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return undefined;
  return parsed;
}

// The host expands local hours, holidays, and timezone rules into UTC intervals
// before admitting the call. Unknown evidence cannot be treated as a confirmed closure.
export function staffingWindowStatus(policy: CallPolicy, now: string): "open" | "closed" | "unknown" {
  const current = instant(now);
  const coverageStart = instant(policy.staffedCoverage?.startsAt);
  const coverageEnd = instant(policy.staffedCoverage?.endsAt);
  const intervals = policy.staffedIntervals;
  if (current === undefined || coverageStart === undefined || coverageEnd === undefined ||
      coverageStart >= coverageEnd || coverageEnd - coverageStart > 72 * 60 * 60 * 1_000 ||
      current < coverageStart || current >= coverageEnd || !Array.isArray(intervals) || intervals.length > 512) return "unknown";
  let open = false;
  for (const interval of intervals as StaffedInterval[]) {
    if (!interval || typeof interval !== "object") return "unknown";
    const start = instant(interval.startsAt);
    const end = instant(interval.endsAt);
    if (start === undefined || end === undefined || start < coverageStart || end > coverageEnd || start >= end) return "unknown";
    if (start <= current && current < end) open = true;
  }
  return open ? "open" : "closed";
}

export function staffedForTransfer(policy: CallPolicy, now: string): boolean {
  return staffingWindowStatus(policy, now) === "open";
}
