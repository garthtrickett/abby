import type { CallState } from "./model.ts";

export const staffUnavailableText = "I can't send that staff request from this call. Please contact the clinic directly.";
export const validStaffLabel = (value: unknown): value is string => typeof value === "string" &&
  value.trim() === value && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);

/** A persisted request is distinct from a human acknowledgment or resolution. */
export function staffOutcomeText(state: CallState, item = Object.values(state.staffItems).filter(item => item.reason === "callerRequested").at(-1)): string {
  if (!item) return "No staff request is confirmed in this call. Please contact the clinic directly.";
  const person = item.requestedPerson && validStaffLabel(item.requestedPerson) ? ` to speak to ${item.requestedPerson}` : "";
  if (item.status === "open") return `Your staff request${person} was saved. I can't confirm that staff have read it or promise a callback time.`;
  if (item.status === "acknowledged") return `The clinic has acknowledged your staff request${person}. I can't promise a callback time.`;
  if (item.status === "resolved") return "The clinic has marked your staff request resolved. Please contact the clinic if you still need help.";
  const effect = state.effects[`${item.key}:open`];
  return effect?.kind === "staffTask" && (effect.status === "possiblySent" || effect.status === "uncertain")
    ? "I can't confirm whether your staff request was saved or received. I won't send it again automatically. Please contact the clinic directly."
    : item.status === "requested" ? "Your staff request is not confirmed yet."
      : staffUnavailableText;
}
