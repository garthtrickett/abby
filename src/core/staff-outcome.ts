import type { CallState } from "./model.ts";
import { staffReviewProcessText, validStaffReviewProcess } from "./staff-review-process.ts";
import type { StaffReviewProcess } from "./staff-review-process.ts";
import { staffRequestSubjectLabel, staffRequestSubjectLimit, validStaffRequestSubject } from "./staff-request-subject.ts";

export const staffUnavailableText = "I can't send that staff request from this call. Please contact the clinic directly.";
export const validStaffLabel = (value: unknown): value is string => typeof value === "string" &&
  value.trim() === value && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);

/** A persisted request is distinct from a human acknowledgment or resolution. */
export function staffOutcomeText(state: CallState, item = Object.values(state.staffItems).filter(item => item.reason === "callerRequested").at(-1), process?: StaffReviewProcess, now?: string): string {
  if (!item) return "No staff request is confirmed in this call. Please contact the clinic directly.";
  const person = item.requestedPerson && validStaffLabel(item.requestedPerson) ? ` to speak to ${item.requestedPerson}` : "";
  const subject = validStaffRequestSubject(item.requestSubject) ? item.requestSubject : undefined;
  const description = subject ? ` about ${staffRequestSubjectLabel[subject]}` : "", limit = subject ? ` ${staffRequestSubjectLimit[subject]}` : "";
  const expectation = process?.taskKey === item.key && now && validStaffReviewProcess(process, state, now) ? staffReviewProcessText(process) : "";
  if (item.status === "open") return `Your staff request${description}${person} was saved. I can't confirm that staff have read it or promise a callback time.${expectation}${limit}`;
  if (item.status === "acknowledged") return `The clinic has acknowledged your staff request${description}${person}. I can't promise a callback time.${expectation}${limit}`;
  if (item.status === "resolved") return `The clinic has marked your staff request${description} resolved. Please contact the clinic if you still need help.${limit}`;
  const effect = state.effects[`${item.key}:open`];
  return effect?.kind === "staffTask" && (effect.status === "possiblySent" || effect.status === "uncertain")
    ? `I can't confirm whether your staff request${description} was saved or received. I won't send it again automatically. Please contact the clinic directly.${limit}`
    : item.status === "requested" ? `Your staff request${description} is not confirmed yet.${limit}`
      : staffUnavailableText + limit;
}
