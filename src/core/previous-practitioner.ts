import { normalizedSpokenName } from "./pending-location.ts";
import type { CallState, LocationScope } from "./model.ts";

export type PreviousPractitionerResult = Readonly<{ kind: "found"; practitionerName: string }> | Readonly<{ kind: "none" | "ambiguous" }>;
export type PreviousPractitionerRead = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  checkedAt: string; lookBackDays: number; result: PreviousPractitionerResult }>;
export const previousPractitionerUnavailable = "I can't check previous practitioners from this call. Please contact the clinic for help.";
export function previousPractitionerText(value: PreviousPractitionerRead, state: CallState, now: string): string | undefined {
  if (!value || value.callId !== state.callId || value.sessionId !== state.sessionLease?.sessionId || value.policyVersion !== state.policy.policyVersion ||
      !value.scope || ["tenantId", "clinicId", "locationId"].some(key => value.scope[key as keyof LocationScope] !== state.policy.scope[key as keyof LocationScope]) ||
      !Number.isFinite(Date.parse(value.checkedAt)) || !Number.isFinite(Date.parse(now)) || Math.abs(Date.parse(now) - Date.parse(value.checkedAt)) > 30_000 ||
      !Number.isSafeInteger(value.lookBackDays) || value.lookBackDays < 1 || value.lookBackDays > 36525 || !value.result) return undefined;
  if (value.result.kind === "found" && Object.keys(value.result).sort().join(",") === "kind,practitionerName" && normalizedSpokenName(value.result.practitionerName))
    return `Your most recent past appointment record in this clinic's ${value.lookBackDays}-day search period names ${value.result.practitionerName}. To make another appointment, please ask to book and choose the practitioner from the available options.`;
  if (Object.keys(value.result).join(",") !== "kind") return undefined;
  return value.result.kind === "none" ? `I couldn't find a past appointment record in this clinic's ${value.lookBackDays}-day search period. Please contact the clinic if you need help checking older records.`
    : value.result.kind === "ambiguous" ? "I can't identify a single practitioner from the most recent appointment records. Please contact the clinic to check this." : undefined;
}
