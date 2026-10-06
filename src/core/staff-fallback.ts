import type { CallState } from "./model.ts";

const NO_STAFF_WORK_NOTICE = "I can't send a staff request from this call. Please contact the clinic directly.";

/** A staff-task outcome must never be spoken when the captured host has no proven task route. */
export function staffFallbackText(state: CallState, whenAvailable: string): string {
  return state.policy.staffWorkEnabled === false ? NO_STAFF_WORK_NOTICE : whenAvailable;
}

export function staffRequestNotice(state: CallState, staffWorkUnavailable = false): string {
  return staffWorkUnavailable ? NO_STAFF_WORK_NOTICE : staffFallbackText(state, "I can request staff follow-up, but I can't confirm they have received it yet.");
}
