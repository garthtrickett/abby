import type { ActionRequest, ActionState, CallState } from "./model.ts";
import { classMovementOutcomeText } from "./class-movement-continuation.ts";

export function confirmedActionText(kind: ActionRequest["kind"]): string {
  switch (kind) {
    case "book": return "Your booking is confirmed.";
    case "cancel": return "Your appointment cancellation is confirmed.";
    case "reschedule": return "Your appointment move is confirmed.";
    case "intake": return "Your details were saved. No appointment is confirmed yet.";
    case "patientUpdate": return "Your patient details match the confirmed correction. Your appointments remain unchanged.";
    case "confirmationResend": return "The mail service accepted your appointment-details email. I can't confirm that it reached your inbox.";
  }
}

/** Status comes from the committed SAM record, never caller or model wording. */
export function actionOutcomeText(action: ActionState | undefined): string {
  if (!action) return "I haven't completed an action in this call.";
  if (action.classMovement) return classMovementOutcomeText(action.classMovement);
  if (action.status === "committed") return confirmedActionText(action.kind);
  if (action.status === "uncertain" || action.status === "needsReview" || action.status === "dispatched")
    return action.kind === "intake" && action.mutation.request.kind === "intake" && action.mutation.request.recoveryContract === "callerMediated"
      ? "I can't confirm that your details were saved. No appointment or staff request is confirmed. Contact the clinic before trying again."
      : "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call.";
  return action.status === "awaitingConfirmation" || action.status === "ready"
    ? "That action is not confirmed yet. I still need your separate confirmation." : "That action was not completed.";
}

/** Keep the selected receipt and its wording inside the same call-task boundary. */
export function currentTaskOutcome(state: Pick<CallState, "actions" | "previousTaskActionKeys">): Readonly<{ action: ActionState | undefined; text: string }> {
  const action = Object.values(state.actions).filter(item => !state.previousTaskActionKeys?.includes(item.key)).at(-1);
  return { action, text: !action && state.previousTaskActionKeys?.length
    ? "I haven't completed an action for this new task." : actionOutcomeText(action) };
}
