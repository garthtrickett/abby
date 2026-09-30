import type { LocationScope } from "../core/model.ts";

export type OperationalCounterKind = "admissionDenied" | "callOwnerStarted" | "voiceFailure" | "callEnded";
export type OperationalCounts = Readonly<Record<OperationalCounterKind, number>>;
export type OperationalCounterSink = Readonly<{
  record: (scope: LocationScope, kind: OperationalCounterKind) => void;
}>;

function emptyCounts(): Record<OperationalCounterKind, number> {
  return { admissionDenied: 0, callOwnerStarted: 0, voiceFailure: 0, callEnded: 0 };
}

function scopeKey(scope: LocationScope): string {
  return JSON.stringify([scope.tenantId, scope.clinicId, scope.locationId]);
}

/** Volatile, fixed-code totals. No event time, call key, caller number or free text is retained. */
export class StandaloneOperationalCounters implements OperationalCounterSink {
  readonly #counts = new Map<string, Record<OperationalCounterKind, number>>();

  record(scope: LocationScope, kind: OperationalCounterKind): void {
    const current = this.#counts.get(scopeKey(scope)) ?? emptyCounts();
    if (!Object.hasOwn(current, kind)) return;
    if (current[kind] < Number.MAX_SAFE_INTEGER) current[kind] += 1;
    this.#counts.set(scopeKey(scope), current);
  }

  /** The caller must authenticate and authorize this clinic scope before exposing the result. */
  snapshot(scope: LocationScope): OperationalCounts {
    return { ...(this.#counts.get(scopeKey(scope)) ?? emptyCounts()) };
  }
}
