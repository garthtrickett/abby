import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok, POSSIBLE_SEND_RECOVERY_DELAY_MS } from "./model.ts";
import type { ActionKind, ActionState, CallPolicy, CallState, Result, TransitionFailure } from "./model.ts";
import type { NotificationBinding, NotificationKind } from "./notification-policy.ts";

export type NotificationDirective = NotificationBinding & Readonly<{ notificationKey: string }>;
/** Patient content and recipient are resolved by the approved host from this committed host reference. */
export type NotificationIntent = NotificationDirective & Readonly<{
  callId: string;
  actionKey: string;
  policyVersion: string;
  hostRef: string;
}>;
export type NotificationObservation = Readonly<{
  notificationKey: string;
  owner: NotificationBinding["owner"];
  hostVersion: string;
}> & (Readonly<{ kind: "sent"; deliveryRef: string }> | Readonly<{ kind: "definitiveUnsent" | "unknown" }>);
export type NotificationEffect =
  | Readonly<{ kind: "notification"; id: string; actionKey: string; intent: NotificationIntent;
    status: "pending" | "possiblySent" | "completed" | "uncertain" | "needsReview" | "canceled";
    possiblySentAt?: string; deadline?: string; observation?: NotificationObservation;
    blockedReason?: "suppressionUnproven" | "hostUnavailable" | "emergencyStop" }>
  | Readonly<{ kind: "notificationReconcile"; id: string; originalEffectId: string; actionKey: string;
    intent: NotificationIntent; status: "pending" | "completed" }>;
export type NotificationTransitionAction =
  | Readonly<{ kind: "markNotificationPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "recoverNotificationPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "notificationBlocked"; effectId: string; reason: "hostUnavailable" | "emergencyStop"; now: string }>
  | Readonly<{ kind: "notificationResolved"; effectId: string; observation: NotificationObservation; now: string }>
  | Readonly<{ kind: "notificationReconciled"; effectId: string; observation: NotificationObservation; now: string }>;

export function notificationKind(action: ActionKind): NotificationKind | undefined {
  return action === "book" ? "bookingConfirmation" : action === "cancel" ? "cancellationConfirmation"
    : action === "reschedule" ? "reschedulingConfirmation" : undefined;
}
export function notificationDirective(policy: CallPolicy, callId: string, actionKey: string,
  action: ActionKind): NotificationDirective | undefined {
  const kind = notificationKind(action);
  if (!kind) return undefined;
  const binding = policy.notificationBindings?.[kind];
  if (!binding || binding.kind !== kind || !isDeepStrictEqual(binding.scope, policy.scope) ||
      binding.settingsVersion !== policy.notificationSettings?.version ||
      binding.owner !== policy.notificationSettings?.owners[kind]) return undefined;
  const notificationKey = createHash("sha256").update(JSON.stringify([
    "notification:v1", policy.scope.tenantId, policy.scope.clinicId, policy.scope.locationId, callId, actionKey, kind,
  ])).digest("hex");
  return { ...structuredClone(binding), notificationKey };
}

/** Queue only after a proven appointment commit, and require an exact host suppression acknowledgement. */
export function queueCommittedNotification(state: CallState, action: ActionState, hostRef: string,
  accepted: NotificationDirective | undefined): void {
  const directive = action.mutation.notification;
  if (!directive) return;
  const id = `${directive.notificationKey}:notification`;
  if (state.effects[id]) return;
  const intent = { ...structuredClone(directive), callId: state.callId, actionKey: action.key,
    policyVersion: action.mutation.policyVersion, hostRef };
  state.effects[id] = { kind: "notification", id, actionKey: action.key, intent,
    ...(isDeepStrictEqual(accepted, directive) ? { status: "pending" as const }
      : { status: "needsReview" as const, blockedReason: "suppressionUnproven" as const }) };
}

export function unknownNotification(intent: NotificationIntent): NotificationObservation {
  return { kind: "unknown", notificationKey: intent.notificationKey, owner: intent.owner, hostVersion: intent.hostVersion };
}
export function validNotificationObservation(value: unknown, intent: NotificationIntent): value is NotificationObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const fields = row.kind === "sent" ? "deliveryRef,hostVersion,kind,notificationKey,owner" : "hostVersion,kind,notificationKey,owner";
  return Object.keys(row).sort().join(",") === fields && row.notificationKey === intent.notificationKey &&
    row.owner === intent.owner && row.hostVersion === intent.hostVersion &&
    (row.kind === "unknown" || row.kind === "definitiveUnsent" || row.kind === "sent" &&
      typeof row.deliveryRef === "string" && row.deliveryRef.trim().length > 0 && row.deliveryRef.length <= 256);
}
function queueReconciliation(state: CallState, original: Extract<NotificationEffect, { kind: "notification" }>): void {
  const id = `${original.id}:reconcile`;
  state.effects[id] = { kind: "notificationReconcile", id, originalEffectId: original.id,
    actionKey: original.actionKey, intent: structuredClone(original.intent), status: "pending" };
}
function linkedCommit(state: CallState, effect: Extract<NotificationEffect, { kind: "notification" }>): boolean {
  const action = state.actions[effect.actionKey];
  return !!action && action.status === "committed" && action.hostRef === effect.intent.hostRef &&
    effect.intent.callId === state.callId && effect.intent.actionKey === action.key &&
    effect.intent.policyVersion === action.mutation.policyVersion &&
    isDeepStrictEqual(effect.intent.scope, state.policy.scope) &&
    isDeepStrictEqual(action.mutation.notification, notificationDirective(state.policy, state.callId, action.key, action.kind)) &&
    isDeepStrictEqual(effect.intent, { ...action.mutation.notification, callId: state.callId,
      actionKey: action.key, policyVersion: action.mutation.policyVersion, hostRef: action.hostRef });
}

/** Validate before either delivery or observation can reach a host with a corrupted effect payload. */
export function validNotificationEffectForCall(state: CallState, effect: NotificationEffect): boolean {
  const expectedId = `${effect.intent.notificationKey}:notification`;
  if (effect.kind === "notification") return effect.id === expectedId && linkedCommit(state, effect);
  const original = state.effects[effect.originalEffectId];
  return effect.id === `${expectedId}:reconcile` && effect.originalEffectId === expectedId &&
    !!original && original.kind === "notification" && original.status === "uncertain" &&
    effect.actionKey === original.actionKey && linkedCommit(state, original) && isDeepStrictEqual(effect.intent, original.intent);
}

/** Called inside the SAM transaction on its cloned state. No live setting is consulted here. */
export function transitionNotification(state: CallState, action: NotificationTransitionAction): Result<void, TransitionFailure> {
  const effect = state.effects[action.effectId];
  if (!effect || effect.kind !== "notification" && effect.kind !== "notificationReconcile") return err({ kind: "effectUnknown" });
  if (action.kind === "notificationReconciled") {
    if (effect.kind !== "notificationReconcile") return err({ kind: "effectUnknown" });
    if (effect.status === "completed") return ok(undefined);
    const original = state.effects[effect.originalEffectId];
    if (!original || original.kind !== "notification" || original.status !== "uncertain" ||
        !linkedCommit(state, original) || !isDeepStrictEqual(original.intent, effect.intent)) return err({ kind: "invalidTransition" });
    if (!validNotificationObservation(action.observation, effect.intent)) return err({ kind: "keyMismatch" });
    if (action.observation.kind === "unknown" && original.deadline && Date.parse(action.now) < Date.parse(original.deadline)) return ok(undefined);
    state.effects[original.id] = { ...original, status: action.observation.kind === "unknown" ? "needsReview" : "completed",
      observation: structuredClone(action.observation) };
    state.effects[effect.id] = { ...effect, status: "completed" };
    return ok(undefined);
  }
  if (effect.kind !== "notification") return err({ kind: "effectUnknown" });
  if (!linkedCommit(state, effect)) return err({ kind: "invalidTransition" });
  if (action.kind === "markNotificationPossiblySent") {
    if (effect.status !== "pending") return err({ kind: "invalidTransition" });
    state.effects[effect.id] = { ...effect, status: "possiblySent", possiblySentAt: action.now,
      deadline: new Date(Date.parse(action.now) + 24 * 60 * 60 * 1000).toISOString() };
  } else if (action.kind === "notificationBlocked") {
    if (effect.status !== "pending") return err({ kind: "invalidTransition" });
    state.effects[effect.id] = { ...effect, status: "canceled", blockedReason: action.reason };
  } else if (action.kind === "recoverNotificationPossiblySent") {
    if (effect.status === "uncertain") return ok(undefined);
    if (effect.status !== "possiblySent" || !effect.possiblySentAt ||
        Date.parse(action.now) < Date.parse(effect.possiblySentAt) + POSSIBLE_SEND_RECOVERY_DELAY_MS) return err({ kind: "invalidTransition" });
    state.effects[effect.id] = { ...effect, status: "uncertain", observation: unknownNotification(effect.intent) };
    queueReconciliation(state, effect);
  } else {
    if (effect.status === "completed" || effect.status === "uncertain") return ok(undefined);
    if (effect.status !== "possiblySent") return err({ kind: "invalidTransition" });
    if (!validNotificationObservation(action.observation, effect.intent)) return err({ kind: "keyMismatch" });
    state.effects[effect.id] = { ...effect, status: action.observation.kind === "unknown" ? "uncertain" : "completed",
      observation: structuredClone(action.observation) };
    if (action.observation.kind === "unknown") queueReconciliation(state, effect);
  }
  return ok(undefined);
}
