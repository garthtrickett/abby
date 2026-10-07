import { financialEvidenceText, isFinancialEvidenceReason } from "./financial-evidence.ts";
import type { FinancialEvidenceReason } from "./financial-evidence.ts";
import { normalizedSpokenName } from "./pending-location.ts";
import { confirmedActionText } from "./action-outcome.ts";
import type { ActionState, MenuClarificationReason } from "./model.ts";

const notices: Record<Exclude<MenuClarificationReason, "changeAfterSend" | "oldAppointmentAfterMove" | FinancialEvidenceReason>, string> = {
  unattendedAnnouncement: "I heard an automated announcement or repeated clinic message. Please tell me your request when you're ready. Repeated announcements will end this call; contact the clinic if you still need help.",
  arrivalAccessUnavailable: "I can't verify access or get someone to open the door from this call. Please contact the clinic directly for arrival assistance. I haven't sent an arrival message or made another appointment change for this request.",
  publicFactConflict: "I can't verify those conflicting details or choose an address or opening time from them. Please contact the clinic to confirm the current information. I haven't changed an appointment for this request.",
  clinicalAdviceUnavailable: "I can’t give medical advice or confirm it is safe to attend. Please contact your clinician or the clinic for advice.",
  proposalCorrection: "Which details would you like to change? I'll ask for a new confirmation before continuing.",
  menuRejected: "I won't choose any of those options. What other date or time would work for you?",
  menuAmbiguous: "Which option did you mean? Please say which displayed day and whether the time is AM or PM, or say its option number.",
  searchPreferenceUnavailable: "I can only use this call’s clinic location and supported practitioners. I can’t use that preference on this call. Please contact the clinic for another practitioner or branch.",
  menuUnavailable: "Please ask for fresh appointment options before choosing a time.",
  changeAmbiguous: "Would you like to move the existing appointment, or cancel it without a replacement? Each needs exact details and a new confirmation.",
  targetDisagreement: "Let's check which appointment you mean before changing anything. Please request your appointments again.",
  changeUnsupported: "I can't change the patient or appointment type or duration in this workflow. Please contact the clinic about that change.",
};

export function clarificationText(reason: MenuClarificationReason | undefined, latest?: Pick<ActionState, "kind" | "status">, approvedLocation?: string): string {
  if (isFinancialEvidenceReason(reason)) return financialEvidenceText(reason, latest);
  if (reason === "oldAppointmentAfterMove") {
    if (latest?.kind === "reschedule" && latest.status === "committed")
      return "Your original appointment has already been moved to the confirmed new time. I haven't canceled the replacement appointment. Please contact the clinic if you want to change or cancel that appointment.";
    // The caller's description cannot establish that a move happened. Use the
    // actual receipt, or recheck the target when no action was possibly sent.
    return latest && ["committed", "uncertain", "needsReview", "dispatched"].includes(latest.status)
      ? clarificationText("changeAfterSend", latest) : notices.targetDisagreement;
  }
  if (reason === "searchPreferenceUnavailable" && normalizedSpokenName(approvedLocation))
    return `This call supports appointments at ${approvedLocation}. I can’t use that practitioner or another branch on this call. Please contact the clinic for another practitioner or location.`;
  if (reason !== "changeAfterSend") return reason ? notices[reason] : "Could you repeat that for me?";
  const outcome = latest?.status === "committed" ? confirmedActionText(latest.kind) : "I can't confirm the previous action yet.";
  return `${outcome} I haven't made another change. Please contact the clinic to review it before trying another change.`;
}
