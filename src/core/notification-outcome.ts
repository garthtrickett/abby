import type { CallState } from "./model.ts";
import { actionOutcomeText } from "./action-outcome.ts";
import { validNotificationEffectForCall, validNotificationObservation } from "./notification-effects.ts";

const unavailable = "I can't verify that an email confirmation was sent or deliver one from this call. Please contact the clinic for written confirmation.";
const noResend = "I can't send or resend an email from this call. Please contact the clinic for written confirmation.";

/** Read captured receipts only. This cannot queue, inspect, retry or change ownership. */
export function notificationOutcomeText(state: CallState): string {
  const action = Object.values(state.actions).filter(item => !state.previousTaskActionKeys?.includes(item.key)).at(-1);
  const prefix = !action && state.previousTaskActionKeys?.length ? "I haven't completed an action for this new task." : actionOutcomeText(action);
  if (action?.kind === "confirmationResend") return prefix;
  const effects = Object.values(state.effects).filter(effect => effect.kind === "notification" && effect.actionKey === action?.key);
  const effect = effects.length === 1 ? effects[0] : undefined;
  if (!action || action.status !== "committed" || !effect || effect.kind !== "notification" ||
      !validNotificationEffectForCall(state, effect)) return `${prefix} ${unavailable}`;
  if (effect.status === "completed" && effect.observation && validNotificationObservation(effect.observation, effect.intent)) {
    if (effect.observation.kind === "sent") return `${prefix} The approved notification service reported sending a confirmation. I can't confirm that it was an email or that it reached your inbox. ${noResend}`;
    if (effect.observation.kind === "definitiveUnsent") return `${prefix} The approved notification service reported that the confirmation was not sent. ${noResend}`;
  }
  if (effect.status === "pending") return `${prefix} Confirmation delivery is pending with the approved notification service. I can't confirm that it was sent or received. ${noResend}`;
  return `${prefix} ${unavailable}`;
}
