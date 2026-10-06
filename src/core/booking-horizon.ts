import type { CallState, LocationScope } from "./model.ts";
import { actionOutcomeText } from "./action-outcome.ts";

/** Public clinic limits only: neither available times nor patient authority. */
export type BookingHorizonRead = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  operation: "book" | "reschedule"; observedAt: string; expiresAt: string;
  bounds: readonly Readonly<{ practitionerName: string | null; minNoticeMinutes: number; maxAdvanceDays: number }>[];
}>;
export const bookingHorizonUnavailable = "I can't verify the approved appointment search limits right now. Please contact the clinic directly about your requested date.";
export function bookingHorizonText(state: CallState, read?: BookingHorizonRead): string {
  const sent = Object.values(state.actions).filter(action => ["dispatched", "committed", "uncertain", "needsReview"].includes(action.status)).at(-1);
  const prefix = sent ? `${actionOutcomeText(sent)} ` : "";
  if (!read) return prefix + bookingHorizonUnavailable;
  const limits = read.bounds.map(bound => `${bound.practitionerName ? `for ${bound.practitionerName}, ` : ""}starts at least ${bound.minNoticeMinutes} ${bound.minNoticeMinutes === 1 ? "minute" : "minutes"} ahead and no more than ${bound.maxAdvanceDays} ${bound.maxAdvanceDays === 1 ? "day" : "days"} ahead`);
  const head = read.bounds.length === 1 && read.bounds[0]?.practitionerName === null
    ? `The approved appointment search on this call allows ${limits[0]}. ` : `The approved appointment search limits on this call are: ${limits.join("; ")}. `;
  return prefix + head + "Please choose an exact date within those limits, or contact the clinic directly about dates beyond them. I haven't searched availability or changed an appointment for this request.";
}
export function validBookingHorizon(read: BookingHorizonRead, state: CallState, sessionId: string, now: string): boolean {
  try {
    const at = Date.parse(now), observed = Date.parse(read.observedAt), expires = Date.parse(read.expiresAt);
    return Object.keys(read).sort().join(",") === "bounds,callId,expiresAt,observedAt,operation,policyVersion,scope,sessionId" &&
      read.scope.tenantId === state.policy.scope.tenantId && read.scope.clinicId === state.policy.scope.clinicId && read.scope.locationId === state.policy.scope.locationId &&
      read.callId === state.callId && read.sessionId === sessionId && read.policyVersion === state.policy.policyVersion &&
      ["book", "reschedule"].includes(read.operation) && Number.isFinite(at) && Number.isFinite(observed) && Math.abs(at - observed) <= 30_000 &&
      Number.isFinite(expires) && expires > at && expires <= Date.parse(state.sessionLease!.expiresAt) && Array.isArray(read.bounds) && read.bounds.length >= 1 && read.bounds.length <= 3 &&
      read.bounds.every(bound => Object.keys(bound).sort().join(",") === "maxAdvanceDays,minNoticeMinutes,practitionerName" &&
        (bound.practitionerName === null && read.bounds.length === 1 || typeof bound.practitionerName === "string" && bound.practitionerName.trim() === bound.practitionerName &&
          bound.practitionerName.length >= 1 && bound.practitionerName.length <= 120 && /^[\p{L}\p{M}\p{N} .,'()&/-]+$/u.test(bound.practitionerName)) &&
        Number.isSafeInteger(bound.minNoticeMinutes) && bound.minNoticeMinutes >= 1 && bound.minNoticeMinutes <= 10_080 &&
        Number.isSafeInteger(bound.maxAdvanceDays) && bound.maxAdvanceDays >= 1 && bound.maxAdvanceDays <= 90 && bound.minNoticeMinutes < bound.maxAdvanceDays * 1440) &&
      new Set(read.bounds.map(bound => bound.practitionerName)).size === read.bounds.length;
  } catch { return false; }
}
