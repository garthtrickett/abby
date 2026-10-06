import { confirmedActionText } from "./action-outcome.ts";
import type { ActionState, MenuClarificationReason } from "./model.ts";

const notices: Record<Exclude<MenuClarificationReason, "changeAfterSend">, string> = {
  proposalCorrection: "Which details would you like to change? I'll ask for a new confirmation before continuing.",
  menuRejected: "I won't choose any of those options. What other date or time would work for you?",
  menuAmbiguous: "Which option did you mean? Please say its option number or its full date and time.",
  menuUnavailable: "Please ask for fresh appointment options before choosing a time.",
  changeAmbiguous: "Would you like to move the existing appointment, or cancel it without a replacement? Each needs exact details and a new confirmation.",
  targetDisagreement: "Let's check which appointment you mean before changing anything. Please request your appointments again.",
  changeUnsupported: "I can't change the patient or appointment type or duration in this workflow. Please contact the clinic about that change.",
};

export function clarificationText(reason: MenuClarificationReason | undefined, latest?: Pick<ActionState, "kind" | "status">): string {
  if (reason !== "changeAfterSend") return reason ? notices[reason] : "Could you repeat that for me?";
  const outcome = latest?.status === "committed" ? confirmedActionText(latest.kind) : "I can't confirm the previous action yet.";
  return `${outcome} I haven't made another change. Please contact the clinic to review it before trying another change.`;
}
