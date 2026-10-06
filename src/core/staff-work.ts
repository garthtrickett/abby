import { err, ok } from "./model.ts";
import type { ActionRequest, CallState, Effect, Result, StaffChangeRequest, StaffItem, StaffReason, TransitionFailure } from "./model.ts";

export type StaffPlan = Readonly<{ item: StaffItem; effect: Extract<Effect, { kind: "staffChange" }> }>;

/** Stage one staff request and its host effect in the same call transition. */
export function addStaffTask(state: CallState, reason: StaffReason, now: string, linkedActionKey?: string, request?: ActionRequest, requestedPerson?: string, requestSubject?: import("./staff-request-subject.ts").StaffRequestSubject): void {
  if (state.callerIdentityDenied || state.policy.staffWorkEnabled === false) return;
  if (linkedActionKey && Object.values(state.staffItems).some(item => item.linkedActionKey === linkedActionKey)) return;
  const key = `${state.callId}:staff:${Object.keys(state.staffItems).length + 1}`;
  const item = {
    key,
    scope: state.policy.scope,
    reason,
    destination: state.policy.staffDestination,
    dueAt: new Date(Date.parse(now) + (reason === "potentiallyUrgent" ? 0 : 24 * 60 * 60 * 1000)).toISOString(),
    status: "requested" as const,
    ...(requestedPerson === undefined ? {} : { requestedPerson }),
    ...(requestSubject === undefined ? {} : { requestSubject }),
    ...(linkedActionKey === undefined ? {} : { linkedActionKey }),
    ...(request === undefined ? {} : { request }),
  };
  state.staffItems[key] = item;
  state.effects[`${key}:open`] = { kind: "staffTask", id: `${key}:open`, taskKey: key, status: "pending" };
}

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
