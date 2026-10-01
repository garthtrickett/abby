import type { LocationScope } from "../core/model.ts";
import { emptyOperationalCounts, operationalDays } from "../voice/operational-counts.ts";
import type { OperationalCounterKind, OperationalCounts, OperationalCounterStore } from "../voice/operational-counts.ts";
export type { OperationalCounterKind, OperationalCounts, OperationalCounterStore } from "../voice/operational-counts.ts";

function scopeKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]);
}

/** Volatile, fixed-code totals. No event time, call key, caller number or free text is retained. */
export class StandaloneOperationalCounters implements OperationalCounterStore {
  readonly #counts = new Map<string, Record<OperationalCounterKind, number>>();
  readonly #daily = new Map<string, Map<string, Record<OperationalCounterKind, number>>>();
  readonly #clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) { this.#clock = clock; }

  record(scope: LocationScope, kind: OperationalCounterKind): void {
    const key = scopeKey(scope);
    const current = this.#counts.get(key) ?? emptyOperationalCounts();
    if (!Object.hasOwn(current, kind)) return;
    const days = operationalDays(this.#clock());
    const byDay = this.#daily.get(key) ?? new Map<string, Record<OperationalCounterKind, number>>();
    for (const date of byDay.keys()) if (!days.includes(date)) byDay.delete(date);
    const day = days.at(-1)!;
    const daily = byDay.get(day) ?? emptyOperationalCounts();
    if (current[kind] < Number.MAX_SAFE_INTEGER) current[kind] += 1;
    if (daily[kind] < Number.MAX_SAFE_INTEGER) daily[kind] += 1;
    byDay.set(day, daily);
    this.#counts.set(key, current);
    this.#daily.set(key, byDay);
  }

  /** The caller must authenticate and authorize this clinic scope before exposing the result. */
  snapshot(scope: LocationScope): OperationalCounts {
    return { ...(this.#counts.get(scopeKey(scope)) ?? emptyOperationalCounts()) };
  }

  daily(scope: LocationScope) {
    const days = operationalDays(this.#clock());
    const byDay = this.#daily.get(scopeKey(scope));
    return { days: days.map(date => ({ date, counts: { ...(byDay?.get(date) ?? emptyOperationalCounts()) } })) };
  }
}
