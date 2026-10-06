import type { ActionRequest, ActionState } from "./model.ts";

export function confirmedActionText(kind: ActionRequest["kind"]): string {
  switch (kind) {
    case "book": return "Your booking is confirmed.";
    case "cancel": return "Your appointment cancellation is confirmed.";
    case "reschedule": return "Your appointment move is confirmed.";
    case "intake": return "Your details were saved. No appointment is confirmed yet.";
  }
}

/** Status comes from the committed SAM record, never caller or model wording. */
export function actionOutcomeText(action: ActionState | undefined): string {
  if (!action) return "I haven't completed an action in this call.";
  if (action.status === "committed") return confirmedActionText(action.kind);
  if (action.status === "uncertain" || action.status === "needsReview" || action.status === "dispatched")
    return action.kind === "intake" && action.mutation.request.kind === "intake" && action.mutation.request.recoveryContract === "callerMediated"
      ? "I can't confirm that your details were saved. No appointment or staff request is confirmed. Contact the clinic before trying again."
      : "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call.";
  return action.status === "awaitingConfirmation" || action.status === "ready"
    ? "That action is not confirmed yet. I still need your separate confirmation." : "That action was not completed.";
}
