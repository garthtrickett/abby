import type { CallState } from "./model.ts";
import { noticePresentationId } from "./notice-presentation-id.ts";

/** A successful protected enquiry is settled only after its actual notice was
 * played. Earlier patients' reads and failed/unplayed reads cannot settle the
 * current workflow. This receipt grants no patient authority. */
export function completedAppointmentEnquiry(state: CallState): CallState["appointmentReads"][number] | undefined {
  const start = state.lastWorkflowStart, read = state.appointmentReads.at(-1);
  if (start?.operation !== "appointments.read" || !read || !["shown", "empty"].includes(read.status) || !read.sourceRef ||
      state.pendingPresentationId || state.processedTurnIds.indexOf(read.turnId) <= state.processedTurnIds.indexOf(start.turnId) ||
      state.processedTurnIds.indexOf(start.turnId) < 0 || state.presentations[noticePresentationId(state.callId, read.turnId)]?.status !== "played") return undefined;
  return read;
}
