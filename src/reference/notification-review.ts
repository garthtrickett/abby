import { err, ok } from "../core/model.ts";
import type { CallState, Result, TransitionFailure } from "../core/model.ts";
import { validNotificationEffectForCall, validNotificationObservation } from "../core/notification-effects.ts";
import { validNotificationReviewRow } from "./notification-review-shape.ts";
import type { NotificationReviewRow } from "./notification-review-shape.ts";

/** Show original intents once, without recipient, content, clinical references or provider identifiers. */
export function reviewNotifications(call: CallState): Result<readonly NotificationReviewRow[], TransitionFailure> {
  const rows: NotificationReviewRow[] = [];
  try {
    for (const effect of Object.values(call.effects)) {
      if (effect.kind !== "notification") continue;
      if (!validNotificationEffectForCall(call, effect) ||
        (effect.observation !== undefined && !validNotificationObservation(effect.observation, effect.intent))) {
        return err({ kind: "storageCorrupt" });
      }
      const row = { kind: effect.intent.kind, owner: effect.intent.owner, status: effect.status,
        ...(effect.observation === undefined ? {} : { outcome: effect.observation.kind }),
        ...(effect.blockedReason === undefined ? {} : { blockedReason: effect.blockedReason }) };
      if (!validNotificationReviewRow(row)) return err({ kind: "storageCorrupt" });
      rows.push(row);
    }
  } catch { return err({ kind: "storageCorrupt" }); }
  return ok(rows);
}
