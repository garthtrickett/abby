import { err, ok } from "./model.ts";
import type { CallState, Effect, Result, StaffChangeRequest, StaffItem, TransitionFailure } from "./model.ts";

export type StaffPlan = Readonly<{ item: StaffItem; effect: Extract<Effect, { kind: "staffChange" }> }>;

/** Pure T2 decision. Host work remains an outbox intent until a matching result is committed. */
export function planStaffChange(state: CallState, taskKey: string, actorRef: string, request: StaffChangeRequest): Result<StaffPlan, TransitionFailure> {
  const item = state.staffItems[taskKey];
  if (!item || item.key !== taskKey || !item.hostTaskRef || item.pendingChangeKey || item.reviewRequired ||
      (item.status !== "open" && item.status !== "acknowledged") ||
      !actorRef?.trim() || actorRef.length > 256) return err({ kind: "invalidTransition" });
  if (item.scope.tenantId !== state.policy.scope.tenantId || item.scope.clinicId !== state.policy.scope.clinicId ||
      item.scope.locationId !== state.policy.scope.locationId) return err({ kind: "scopeMismatch" });
  if (!request || !["acknowledge", "resolve", "reassign"].includes(request.kind)) return err({ kind: "invalidTransition" });
  if (request.kind === "acknowledge" && item.status !== "open") return err({ kind: "invalidTransition" });
  const toDestination = request.kind === "reassign"
    ? request.target === "staff" ? state.policy.staffDestination : request.target === "operator" ? state.policy.operatorQueue : undefined
    : item.destination;
  if (!toDestination || (request.kind === "reassign" && JSON.stringify(toDestination) === JSON.stringify(item.destination))) return err({ kind: "invalidTransition" });
  const commandKey = `${item.key}:change:${state.version + 1}`;
  const change = { commandKey, taskKey: item.key, scope: item.scope, hostTaskRef: item.hostTaskRef, actorRef,
    operation: request.kind, fromStatus: item.status, fromDestination: item.destination, toDestination } as const;
  const effect: Extract<Effect, { kind: "staffChange" }> = { kind: "staffChange", id: `${commandKey}:send`, taskKey: item.key, change, status: "pending" };
  return ok({ item: { ...item, pendingChangeKey: commandKey }, effect });
}
