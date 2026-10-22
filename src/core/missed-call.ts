import type { CallState, FinalCallerTurn, LocationScope } from "./model.ts";

/** Absent independently verified native context, no call reason is known. */
export const missedCallText = "I don't know why the clinic called you. I can't verify an outbound-call reason from this call. Please contact the clinic directly.";

/** Only the trusted host resolves the private subject and original call. No
 * patient, campaign, appointment or provider identifier crosses this seam. */
export type MissedCallContext = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  checkedAt: string; purpose: "followUp" | "sickDay";
}>;

export function readMissedCallContext(value: unknown, state: CallState, turn: FinalCallerTurn, now: string): MissedCallContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "callId,checkedAt,policyVersion,purpose,scope,sessionId") return;
  const read = value as MissedCallContext, scope = read.scope, checked = Date.parse(read.checkedAt), at = Date.parse(now);
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).sort().join(",") !== "clinicId,locationId,tenantId" ||
      scope.tenantId !== state.policy.scope.tenantId || scope.clinicId !== state.policy.scope.clinicId || scope.locationId !== state.policy.scope.locationId ||
      read.callId !== state.callId || read.sessionId !== turn.sessionId || read.sessionId !== state.sessionLease?.sessionId ||
      read.policyVersion !== state.policy.policyVersion || !["followUp", "sickDay"].includes(read.purpose) ||
      !Number.isFinite(checked) || !Number.isFinite(at) || checked > at || at - checked > 30_000 ||
      state.callerIdentityDenied || state.admission?.direction === "outbound") return;
  return read;
}

export const missedCallPurposeText = Object.freeze({
  followUp: "The clinic called about arranging a follow-up appointment. I can help with that, or you can contact reception.",
  sickDay: "The clinic called about rescheduling your appointment. I can help with that, or you can contact reception.",
});

/** Whole current caller questions only; reported, quoted and negated context
 * does not become a reason query or permission for patient access. */
export function isMissedCallQuestion(text: string): boolean {
  const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:i missed a call from this number|i missed your call|i(?: am|'m) returning a missed call|you called me) (?:what was (?:it|that) about|why did (?:you|the clinic) call me)$/.test(value) ||
    /^(?:why did (?:you|the clinic) (?:call|ring) me|what was (?:your|the clinic's) (?:missed )?call (?:about|for))$/.test(value);
}
