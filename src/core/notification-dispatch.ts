import type { NotificationHost } from "./host.ts";
import type { CallRuntime } from "./runtime.ts";
import { unknownNotification, validNotificationObservation } from "./notification-effects.ts";
import type { NotificationEffect, NotificationObservation } from "./notification-effects.ts";

type NotificationHostCall = (operation: (signal: AbortSignal) => Promise<NotificationObservation>) => Promise<NotificationObservation>;

/** Uses only the durable intent. A settings lookup here would permit duplicates during an owner change. */
export async function processNotification(runtime: CallRuntime, host: Partial<NotificationHost>, effect: NotificationEffect,
  now: string, hostCall: NotificationHostCall): Promise<void> {
  if (effect.status !== "pending") throw new Error("invalidTransition");
  if (effect.kind === "notification") {
    if (!host.dispatchNotification) {
      const blocked = await runtime.notificationAction(effect.intent.callId,
        { kind: "notificationBlocked", effectId: effect.id, reason: "hostUnavailable", now });
      if (!blocked.ok) throw new Error(blocked.error.kind);
      return;
    }
    const marked = await runtime.notificationAction(effect.intent.callId,
      { kind: "markNotificationPossiblySent", effectId: effect.id, now });
    if (!marked.ok) throw new Error(marked.error.kind);
    if (marked.value.effects[effect.id]?.status === "canceled") return;
    let observation = unknownNotification(effect.intent);
    try {
      const result = await hostCall(signal => host.dispatchNotification!(structuredClone(effect.intent), signal));
      if (validNotificationObservation(result, effect.intent)) observation = result;
    } catch { /* Crossing the send barrier makes any exception uncertain, including a deadline. */ }
    const resolved = await runtime.notificationAction(effect.intent.callId,
      { kind: "notificationResolved", effectId: effect.id, observation, now });
    if (!resolved.ok) throw new Error(resolved.error.kind);
    return;
  }
  let observation = unknownNotification(effect.intent);
  if (host.observeNotification) {
    try {
      const result = await hostCall(signal => host.observeNotification!(structuredClone(effect.intent), signal));
      if (validNotificationObservation(result, effect.intent)) observation = result;
    } catch { /* Observation failures are unknown and never trigger another send. */ }
  }
  const resolved = await runtime.notificationAction(effect.intent.callId,
    { kind: "notificationReconciled", effectId: effect.id, observation, now });
  if (!resolved.ok) throw new Error(resolved.error.kind);
}
