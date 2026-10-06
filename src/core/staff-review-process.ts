import type { CallState, LocationScope } from "./model.ts";

/** Public process evidence only; no reviewer, patient, provider or caller text. */
export type StaffReviewProcess = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  taskKey: string; approvalRevision: string; cadenceMinutes: number; observedAt: string; expiresAt: string;
}>;
export function validStaffReviewProcess(read: StaffReviewProcess, state: CallState, now: string): boolean {
  try {
    const at = Date.parse(now), observed = Date.parse(read.observedAt), expiry = Date.parse(read.expiresAt);
    return Object.keys(read).sort().join(",") === "approvalRevision,cadenceMinutes,callId,expiresAt,observedAt,policyVersion,scope,sessionId,taskKey" &&
      Object.keys(read.scope).sort().join(",") === "clinicId,locationId,tenantId" &&
      read.scope.tenantId === state.policy.scope.tenantId && read.scope.clinicId === state.policy.scope.clinicId && read.scope.locationId === state.policy.scope.locationId &&
      read.callId === state.callId && state.lifecycle === "active" && state.policy.automationEnabled && state.policy.staffWorkEnabled === true && !state.callerIdentityDenied && read.sessionId === state.sessionLease?.sessionId &&
      read.policyVersion === state.policy.policyVersion && state.staffItems[read.taskKey]?.reason === "callerRequested" &&
      state.staffItems[read.taskKey]?.status === "open" && typeof read.approvalRevision === "string" && read.approvalRevision.trim().length > 0 && read.approvalRevision.length <= 256 &&
      Number.isSafeInteger(read.cadenceMinutes) && read.cadenceMinutes >= 1 && read.cadenceMinutes <= 1440 &&
      Number.isFinite(at) && Number.isFinite(observed) && observed <= at && at - observed <= 30_000 &&
      observed >= Date.parse(state.admission!.acceptedAt) && Number.isFinite(expiry) && expiry > at && expiry <= Date.parse(state.sessionLease!.expiresAt);
  } catch { return false; }
}
export function staffReviewProcessText(read: StaffReviewProcess): string {
  return ` The clinic's approved process calls for reviewing saved requests every ${read.cadenceMinutes} ${read.cadenceMinutes === 1 ? "minute" : "minutes"}. This does not promise a response time.`;
}
