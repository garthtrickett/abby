import { isFinancialEvidenceReason } from "./financial-evidence.ts";
import type { CallState, TurnInterpretation } from "./model.ts";

export type CallerIdentityDenial = "identityDisagreement" | "sharedPhone";
export const callerIdentityDenialText = "Thanks for telling me. I won't access or change patient records on this call. Please contact the clinic directly.";
export function validCallerIdentityDenial(value: unknown): value is CallerIdentityDenial {
  return value === "identityDisagreement" || value === "sharedPhone";
}

/** A denial is monotonic within a call. Only independently approved public information survives. */
export function restrictDeniedCaller(state: CallState, interpretation: TurnInterpretation): TurnInterpretation {
  if (!state.callerIdentityDenied) return interpretation;
  switch (interpretation.kind) {
    case "conversationControl": case "conversationPresence": case "missedCallReasonUnavailable": return interpretation;
    case "answer": case "knowledgeFailure": case "availability": case "availabilityFailure": return interpretation;
    case "clarify": if (interpretation.reason === "clinicalAdviceUnavailable" || interpretation.reason === "arrivalAccessUnavailable" || interpretation.reason === "publicFactConflict" || interpretation.reason === "serviceArrangementUnavailable" || isFinancialEvidenceReason(interpretation.reason)) return interpretation; break;
    case "handoff": if (interpretation.reason === "potentiallyUrgent") return { ...interpretation, staffWorkUnavailable: true }; break;
  }
  return { kind: "callerIdentityDenied", reason: state.callerIdentityDenied };
}
