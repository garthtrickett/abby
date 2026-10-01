import type { LocationScope } from "../core/model.ts";

export type OperationalCounterKind = "admissionDenied" | "callOwnerStarted" | "voiceFailure" | "callEnded" |
  "clinikoBudgetDenied" | "clinikoBudgetUnavailable" | "clinikoProvider429" |
  "clinikoProviderUnavailable" | "intentClassificationUnavailable";
export type OperationalCounts = Readonly<Record<OperationalCounterKind, number>>;
export type OperationalDailyCounts = Readonly<{ days: readonly Readonly<{
  date: string; counts: OperationalCounts;
}>[] }>;
export type OperationalDailyReader = Readonly<{
  daily: (scope: LocationScope) => OperationalDailyCounts | Promise<OperationalDailyCounts>;
}>;
export type OperationalCounterStore = Readonly<{
  record: (scope: LocationScope, kind: OperationalCounterKind) => void | Promise<void>;
  snapshot: (scope: LocationScope) => OperationalCounts | Promise<OperationalCounts>;
  daily?: (scope: LocationScope) => OperationalDailyCounts | Promise<OperationalDailyCounts>;
  drain?: () => Promise<void>;
}>;

const keys = ["admissionDenied", "callOwnerStarted", "voiceFailure", "callEnded",
  "clinikoBudgetDenied", "clinikoBudgetUnavailable", "clinikoProvider429",
  "clinikoProviderUnavailable", "intentClassificationUnavailable"] as const;

export function emptyOperationalCounts(): Record<OperationalCounterKind, number> {
  return Object.fromEntries(keys.map(key => [key, 0])) as Record<OperationalCounterKind, number>;
}

/** Seven calendar days in UTC, ending on the current day. */
export function operationalDays(now: string): readonly string[] {
  const instant = Date.parse(now);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== now) {
    throw new RangeError("invalid operational day clock");
  }
  const today = Date.parse(`${now.slice(0, 10)}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) =>
    new Date(today - (6 - index) * 86_400_000).toISOString().slice(0, 10));
}

export function validOperationalCounts(value: unknown): value is OperationalCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const counts = value as Record<string, unknown>;
  return Object.keys(counts).sort().join("|") === [...keys].sort().join("|") &&
    keys.every(key => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0);
}

export function validOperationalDailyCounts(value: unknown): value is OperationalDailyCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).join("|") !== "days") return false;
  const days = (value as { days?: unknown }).days;
  if (!Array.isArray(days) || days.length !== 7) return false;
  let previous = Number.NaN;
  for (const entry of days) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) ||
        Object.keys(entry).sort().join("|") !== "counts|date") return false;
    const row = entry as Record<string, unknown>;
    if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        !Number.isFinite(Date.parse(`${row.date}T00:00:00.000Z`)) ||
        new Date(`${row.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== row.date ||
        !validOperationalCounts(row.counts)) return false;
    const day = Date.parse(`${row.date}T00:00:00.000Z`);
    if (Number.isFinite(previous) && day - previous !== 86_400_000) return false;
    previous = day;
  }
  return true;
}
