import { createHash } from "node:crypto";
import { err, ok } from "./model.ts";
import type {
  ActionRequest, ActionState, CallState, FinalCallerTurn, LocationScope,
  Presentation, Result, StaffReason, TransitionAction, TransitionFailure,
  TurnInterpretation,
} from "./model.ts";

const HOUR = 60 * 60 * 1000;
const POSSIBLE_SEND_RECOVERY_DELAY = 60 * 1000;

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digestFor(request: ActionRequest): string {
  return createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex");
}

function turnDigest(turn: FinalCallerTurn, interpretation: TurnInterpretation): string {
  return createHash("sha256").update(JSON.stringify(canonical({ turn, interpretation }))).digest("hex");
}

function describe(request: ActionRequest): string {
  switch (request.kind) {
    case "book": return `Please confirm the ${request.offer.serviceRef} appointment at ${request.offer.startsAt}.`;
    case "cancel": return `Please confirm cancellation of appointment ${request.target.appointmentRef}.`;
    case "reschedule": return `Please confirm moving appointment ${request.target.appointmentRef} to ${request.offer.startsAt}.`;
    case "intake": return "Please confirm that your approved intake details may be saved. This does not book an appointment.";
  }
}

function requestScope(request: ActionRequest): LocationScope {
  return request.kind === "intake" ? request.scope : request.patient.scope;
}

function evidenceFailure(state: CallState, request: ActionRequest, now: string): TransitionFailure | undefined {
  if (!sameScope(state.policy.scope, requestScope(request))) return { kind: "scopeMismatch" };
  if (request.kind === "intake") {
    if (!request.approvedDraftRef || !request.consentRef || !request.duplicateCheckRef) return { kind: "invalidTransition" };
    return undefined;
  }
  if (Date.parse(request.patient.expiresAt) <= Date.parse(now)) return { kind: "evidenceExpired" };
  if (request.kind === "book" || request.kind === "reschedule") {
    if (!sameScope(state.policy.scope, request.offer.scope)) return { kind: "scopeMismatch" };
    if (Date.parse(request.offer.expiresAt) <= Date.parse(now)) return { kind: "evidenceExpired" };
  }
  if (request.kind === "cancel" || request.kind === "reschedule") {
    if (!sameScope(state.policy.scope, request.target.scope) || request.target.patientRef !== request.patient.patientRef) {
      return { kind: "scopeMismatch" };
    }
  }
  return undefined;
}

function addStaffTask(state: CallState, reason: StaffReason, now: string, linkedActionKey?: string, request?: ActionRequest): void {
  if (linkedActionKey && Object.values(state.staffItems).some(item => item.linkedActionKey === linkedActionKey)) return;
  const key = `${state.callId}:staff:${Object.keys(state.staffItems).length + 1}`;
  const item = {
    key,
    reason,
    destination: state.policy.staffDestination,
    dueAt: new Date(Date.parse(now) + 24 * HOUR).toISOString(),
    status: "requested" as const,
    ...(linkedActionKey === undefined ? {} : { linkedActionKey }),
    ...(request === undefined ? {} : { request }),
  };
  state.staffItems[key] = item;
  state.effects[`${key}:open`] = { kind: "staffTask", id: `${key}:open`, taskKey: key, status: "pending" };
}

function supersedeUnsent(state: CallState): void {
  if (state.pendingPresentationId) {
    const pending = state.presentations[state.pendingPresentationId];
    if (pending && pending.status !== "played") {
      state.presentations[pending.id] = { ...pending, status: "superseded" };
    }
    delete state.pendingPresentationId;
  }
  for (const [key, action] of Object.entries(state.actions)) {
    if (action.status !== "awaitingConfirmation" && action.status !== "ready") continue;
    const presentation = state.presentations[action.presentationId];
    if (presentation && presentation.status !== "played") {
      state.presentations[presentation.id] = { ...presentation, status: "superseded" };
    }
    const effect = state.effects[`${key}:write`];
    if (effect?.kind === "hostWrite" && effect.status === "possiblySent") continue;
    state.actions[key] = { ...action, status: "canceled" };
    if (effect?.kind === "hostWrite" && effect.status === "pending") {
      state.effects[effect.id] = { ...effect, status: "canceled" };
    }
  }
}

function handleRequest(state: CallState, turn: FinalCallerTurn, request: ActionRequest, now: string): Result<void, TransitionFailure> {
  const failure = evidenceFailure(state, request, now);
  if (failure) return err(failure);
  const mode = state.policy.capabilities[request.kind];
  if (mode === "unavailable") {
    state.callerMessages.push("I can't complete that request here.");
    return ok(undefined);
  }
  if (mode === "requestOnly") {
    addStaffTask(state, "unsupported", now, undefined, request);
    state.callerMessages.push("I can request staff follow-up, but I can't confirm they have received it yet.");
    return ok(undefined);
  }

  const digest = digestFor(request);
  const key = createHash("sha256").update(`${state.policy.scope.tenantId}:${state.callId}:${turn.turnId}:${digest}`).digest("hex");
  const presentationId = `${key}:details`;
  const mutation = { kind: request.kind, scope: state.policy.scope, actionKey: key, payloadDigest: digest, policyVersion: state.policy.policyVersion, request };
  const action: ActionState = { key, kind: request.kind, status: "awaitingConfirmation", digest, mutation, presentationId };
  const presentation: Presentation = { id: presentationId, actionKey: key, digest, approvedText: describe(request), status: "pending" };
  state.actions[key] = action;
  state.presentations[presentationId] = presentation;
  state.pendingPresentationId = presentationId;
  return ok(undefined);
}

function handleTurn(state: CallState, turn: FinalCallerTurn, interpretation: TurnInterpretation, now: string): Result<void, TransitionFailure> {
  if (turn.callId !== state.callId || !turn.turnId || !turn.text || !Number.isFinite(Date.parse(turn.at))) return err({ kind: "invalidTransition" });
  if (state.processedTurnIds.includes(turn.turnId)) return ok(undefined);
  if (interpretation.kind !== "affirm") supersedeUnsent(state);
  state.conversationRevision += 1;

  switch (interpretation.kind) {
    case "requestAction": {
      const result = handleRequest(state, turn, interpretation.request, now);
      if (!result.ok) return result;
      break;
    }
    case "affirm": {
      const action = state.actions[interpretation.actionKey];
      if (!interpretation.affirmative || turn.quality !== "clear" || !action || action.status !== "awaitingConfirmation") {
        return err({ kind: "confirmationMissing" });
      }
      if (interpretation.digest !== action.digest) return err({ kind: "digestChanged" });
      if (state.presentations[action.presentationId]?.status !== "played") return err({ kind: "confirmationMissing" });
      const evidence = evidenceFailure(state, action.mutation.request, now);
      if (evidence) return err(evidence);
      state.actions[action.key] = { ...action, status: "ready" };
      state.effects[`${action.key}:write`] = { kind: "hostWrite", id: `${action.key}:write`, actionKey: action.key, mutation: action.mutation, status: "pending" };
      break;
    }
    case "handoff":
      addStaffTask(state, interpretation.reason, now);
      state.callerMessages.push("I can request staff follow-up, but I can't confirm they have received it yet.");
      break;
    case "ambiguousTarget":
      addStaffTask(state, "verificationFailed", now);
      state.callerMessages.push("I can't identify the right appointment safely. I'll request staff follow-up.");
      break;
    case "readFailure":
      if (interpretation.failure === "notFound") {
        state.callerMessages.push(interpretation.target === "patient" ? "I couldn't find a matching patient." : "I couldn't find an eligible time.");
      } else {
        addStaffTask(state, "systemFailure", now);
        state.callerMessages.push(interpretation.target === "patient" ? "I can't check patient records right now." : "I can't check available times right now.");
      }
      break;
    case "answer": {
      const sources = interpretation.sources.filter(source =>
        sameScope(source.scope, state.policy.scope) && source.approved &&
        Date.parse(source.effectiveFrom) <= Date.parse(now) && Date.parse(now) < Date.parse(source.effectiveUntil));
      if (sources.length !== 1 || interpretation.proposedText !== sources[0]?.approvedText) {
        addStaffTask(state, "systemFailure", now);
        state.callerMessages.push("I can't verify that information right now.");
      } else {
        state.callerMessages.push(sources[0].approvedText);
      }
      break;
    }
  }
  state.processedTurnIds.push(turn.turnId);
  state.processedTurnDigests[turn.turnId] = turnDigest(turn, interpretation);
  return ok(undefined);
}

function recordHostResult(state: CallState, effectId: string, receipt: import("./model.ts").HostWriteReceipt, now: string): Result<void, TransitionFailure> {
  const effect = state.effects[effectId];
  if (!effect || effect.kind !== "hostWrite") return err({ kind: "effectUnknown" });
  if (effect.status === "completed" || effect.status === "uncertain") return ok(undefined);
  if (effect.status !== "possiblySent") return err({ kind: "invalidTransition" });
  if (receipt.actionKey !== effect.actionKey) return err({ kind: "keyMismatch" });
  const action = state.actions[effect.actionKey];
  if (!action) return err({ kind: "invalidTransition" });

  if (receipt.kind === "committed") {
    if (!receipt.hostRef) return err({ kind: "invalidTransition" });
    state.actions[action.key] = { ...action, status: "committed", hostRef: receipt.hostRef };
    state.effects[effectId] = { ...effect, status: "completed" };
    state.callerMessages.push(action.kind === "intake" ? "Your details were saved. No appointment is confirmed yet." : `Your ${action.kind === "book" ? "booking" : "appointment change"} is confirmed.`);
  } else if (receipt.kind === "uncertain") {
    if (!Number.isFinite(Date.parse(receipt.reconcileAfter)) || !Number.isFinite(Date.parse(receipt.deadline)) || Date.parse(receipt.deadline) <= Date.parse(now)) return err({ kind: "invalidTransition" });
    state.actions[action.key] = { ...action, status: "uncertain", reconciliationDeadline: receipt.deadline };
    state.effects[effectId] = { ...effect, status: "uncertain" };
    const reconcileId = `${effectId}:reconcile`;
    state.effects[reconcileId] = { kind: "hostReconcile", id: reconcileId, actionKey: action.key, originalEffectId: effectId, status: "pending" };
    state.callerMessages.push("I can't confirm that action yet. It is pending review.");
    if (action.kind === "book" && Object.values(state.actions).some(item => item.kind === "intake" && item.status === "committed")) {
      addStaffTask(state, "partialIntake", now, action.key);
    }
  } else {
    state.actions[action.key] = { ...action, status: receipt.kind === "unsupported" ? "unsupported" : "rejected" };
    state.effects[effectId] = { ...effect, status: "completed" };
    state.callerMessages.push("That action was not completed.");
    if (action.kind === "book" && Object.values(state.actions).some(item => item.kind === "intake" && item.status === "committed")) {
      addStaffTask(state, "partialIntake", now, action.key);
    }
  }
  return ok(undefined);
}

export function transition(current: CallState, action: TransitionAction): Result<CallState, TransitionFailure> {
  if ("now" in action && !Number.isFinite(Date.parse(action.now))) return err({ kind: "invalidTransition" });
  const state = structuredClone(current);
  const now = action.kind === "callerTurn" || action.kind === "markHostPossiblySent" || action.kind === "recoverHostPossiblySent" || action.kind === "markStaffPossiblySent" || action.kind === "recoverStaffPossiblySent" || action.kind === "reconciliationDeadline" || action.kind === "hostWriteResolved" || action.kind === "reconciliationResolved"
    ? action.now : new Date(0).toISOString();

  switch (action.kind) {
    case "callerTurn": {
      if (current.processedTurnIds.includes(action.turn.turnId)) {
        return current.processedTurnDigests[action.turn.turnId] === turnDigest(action.turn, action.interpretation)
          ? ok(current) : err({ kind: "keyMismatch" });
      }
      const result = handleTurn(state, action.turn, action.interpretation, now);
      if (!result.ok) return result;
      break;
    }
    case "presentationStarted": {
      const presentation = state.presentations[action.presentationId];
      if (!presentation || presentation.status !== "pending" || state.pendingPresentationId !== presentation.id) return err({ kind: "invalidTransition" });
      state.presentations[presentation.id] = { ...presentation, status: "started" };
      delete state.pendingPresentationId;
      break;
    }
    case "presentationResolved": {
      const presentation = state.presentations[action.presentationId];
      if (!presentation || presentation.status !== "started") return err({ kind: "invalidTransition" });
      state.presentations[presentation.id] = { ...presentation, status: action.status };
      break;
    }
    case "markHostPossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "hostWrite") return err({ kind: "effectUnknown" });
      const pendingAction = state.actions[effect.actionKey];
      if (effect.status !== "pending" || pendingAction?.status !== "ready" || pendingAction.digest !== effect.mutation.payloadDigest) return err({ kind: "invalidTransition" });
      const evidence = evidenceFailure(state, effect.mutation.request, now);
      if (evidence) return err(evidence);
      state.effects[effect.id] = { ...effect, status: "possiblySent", possiblySentAt: now };
      state.actions[pendingAction.key] = { ...pendingAction, status: "dispatched" };
      break;
    }
    case "recoverHostPossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "hostWrite") return err({ kind: "effectUnknown" });
      if (effect.status === "uncertain") return ok(current);
      if (effect.status !== "possiblySent" || !effect.possiblySentAt || Date.parse(now) < Date.parse(effect.possiblySentAt) + POSSIBLE_SEND_RECOVERY_DELAY) return err({ kind: "invalidTransition" });
      const result = recordHostResult(state, effect.id, {
        kind: "uncertain",
        actionKey: effect.actionKey,
        reconcileAfter: now,
        deadline: new Date(Date.parse(now) + 24 * HOUR).toISOString(),
      }, now);
      if (!result.ok) return result;
      break;
    }
    case "hostWriteResolved": {
      const result = recordHostResult(state, action.effectId, action.receipt, action.now);
      if (!result.ok) return result;
      break;
    }
    case "reconciliationResolved": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "hostReconcile") return err({ kind: "effectUnknown" });
      if (effect.status === "completed") return ok(current);
      if (action.observation.actionKey !== effect.actionKey) return err({ kind: "keyMismatch" });
      const linked = state.actions[effect.actionKey];
      if (!linked || linked.status !== "uncertain") return err({ kind: "invalidTransition" });
      if (action.observation.kind === "exactCommit") {
        if (!action.observation.hostRef) return err({ kind: "invalidTransition" });
        state.actions[linked.key] = { ...linked, status: "committed", hostRef: action.observation.hostRef };
        state.callerMessages.push(linked.kind === "intake" ? "Your details were saved. No appointment is confirmed yet." : `Your ${linked.kind === "book" ? "booking" : "appointment change"} is confirmed.`);
      } else if (action.observation.kind === "definitiveNonCommit") {
        state.actions[linked.key] = { ...linked, status: "rejected" };
        state.callerMessages.push("That action was not completed.");
      } else {
        if (!linked.reconciliationDeadline || Date.parse(action.now) >= Date.parse(linked.reconciliationDeadline)) {
          state.actions[linked.key] = { ...linked, status: "needsReview" };
          addStaffTask(state, "uncertainAction", action.now, linked.key);
        } else {
          return ok(current);
        }
      }
      state.effects[effect.id] = { ...effect, status: "completed" };
      break;
    }
    case "markStaffPossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "staffTask" || effect.status !== "pending") return err({ kind: "invalidTransition" });
      state.effects[effect.id] = { ...effect, status: "possiblySent", possiblySentAt: now };
      break;
    }
    case "recoverStaffPossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "staffTask") return err({ kind: "effectUnknown" });
      if (effect.status === "uncertain") return ok(current);
      if (effect.status !== "possiblySent" || !effect.possiblySentAt || Date.parse(now) < Date.parse(effect.possiblySentAt) + POSSIBLE_SEND_RECOVERY_DELAY) return err({ kind: "invalidTransition" });
      const item = state.staffItems[effect.taskKey];
      if (!item) return err({ kind: "invalidTransition" });
      state.staffItems[item.key] = { ...item, status: "needsReview", destination: state.policy.operatorQueue };
      state.effects[effect.id] = { ...effect, status: "uncertain" };
      break;
    }
    case "staffTaskResolved": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "staffTask" || effect.status !== "possiblySent") return err({ kind: "invalidTransition" });
      if (effect.taskKey !== action.receipt.taskKey) return err({ kind: "keyMismatch" });
      const item = state.staffItems[effect.taskKey];
      if (!item) return err({ kind: "invalidTransition" });
      if (action.receipt.kind === "opened" && JSON.stringify(action.receipt.destination) === JSON.stringify(item.destination)) {
        state.staffItems[item.key] = { ...item, status: "open", hostTaskRef: action.receipt.hostTaskRef };
        state.effects[effect.id] = { ...effect, status: "completed" };
      } else {
        state.staffItems[item.key] = { ...item, status: "needsReview", destination: state.policy.operatorQueue };
        state.effects[effect.id] = { ...effect, status: action.receipt.kind === "uncertain" ? "uncertain" : "completed" };
      }
      break;
    }
    case "reconciliationDeadline": {
      const linked = state.actions[action.actionKey];
      if (!linked || linked.status !== "uncertain" || !linked.reconciliationDeadline || Date.parse(action.now) < Date.parse(linked.reconciliationDeadline)) return err({ kind: "invalidTransition" });
      state.actions[linked.key] = { ...linked, status: "needsReview" };
      addStaffTask(state, "uncertainAction", action.now, linked.key);
      break;
    }
  }
  state.version = current.version + 1;
  return ok(state);
}
