import type { LocationScope } from "../core/model.ts";

export type OperationalCounterKind = "admissionDenied" | "callOwnerStarted" | "voiceFailure" | "callEnded";
export type OperationalCounts = Readonly<Record<OperationalCounterKind, number>>;
export type OperationalCounterStore = Readonly<{
  record: (scope: LocationScope, kind: OperationalCounterKind) => void | Promise<void>;
  snapshot: (scope: LocationScope) => OperationalCounts | Promise<OperationalCounts>;
  drain?: () => Promise<void>;
}>;

const keys = ["admissionDenied", "callOwnerStarted", "voiceFailure", "callEnded"] as const;

export function validOperationalCounts(value: unknown): value is OperationalCounts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const counts = value as Record<string, unknown>;
  return Object.keys(counts).sort().join("|") === [...keys].sort().join("|") &&
    keys.every(key => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0);
}
