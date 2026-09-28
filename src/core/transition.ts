import { createHash } from "node:crypto";
import { digestActionRequest, digestTurn } from "./digest.ts";
import { availabilityPresentation } from "./availability-presentation.ts";
import { appointmentPresentation } from "./appointment-presentation.ts";
import { addStaffTask, planStaffChange } from "./staff-work.ts";
import { staffedForTransfer } from "./staffed-window.ts";
import { validCallKnowledgeSource } from "./knowledge-evidence.ts";
import { acceptModelKnowledge, acceptModelResult, cancelModelWork } from "./model-result.ts";
import { redactSettledContent } from "./presentation-retention.ts";
import { POSSIBLE_SEND_RECOVERY_DELAY_MS, err, ok } from "./model.ts";
import type {
  ActionRequest, ActionState, CallState, CallTerminalReason, FinalCallerTurn, LocationScope,
  Presentation, Result, StaffAlertReason, StaffAlertState, StaffItem, TransitionAction, TransitionFailure,
  TurnInterpretation,
} from "./model.ts";

const HOUR = 60 * 60 * 1000;
const CLOSED_TRANSFER_NOTICE = "Staff aren't available for a live transfer now. I'll request follow-up, but I can't confirm they've received it yet.";

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function turnDigest(turn: FinalCallerTurn, interpretation: TurnInterpretation): string {
  return digestTurn({ turn, interpretation });
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

function alertable(item: StaffItem, reason: StaffAlertReason, now: string): boolean {
  if (item.status === "resolved") return false;
  return reason === "overdue" ? Date.parse(item.dueAt) <= Date.parse(now)
    : item.status === "needsReview" || item.status === "failed" || item.reviewRequired === true;
}

function setAlertState(state: CallState, taskKey: string, reason: StaffAlertReason, status: StaffAlertState): void {
  const item = state.staffItems[taskKey]!;
  state.staffItems[taskKey] = { ...item, alerts: { ...item.alerts, [reason]: status } };
}

function queueStaffReconciliation(state: CallState, originalEffectId: string, item: import("./model.ts").StaffItem): void {
  const id = `${originalEffectId}:reconcile`;
  state.effects[id] = { kind: "staffReconcile", id, taskKey: item.key, originalEffectId, originalItem: structuredClone(item), status: "pending" };
}

function queueStaffChangeReconciliation(state: CallState, original: Extract<import("./model.ts").Effect, { kind: "staffChange" }>): void {
  const id = `${original.id}:reconcile`;
  state.effects[id] = { kind: "staffChangeReconcile", id, taskKey: original.taskKey, originalEffectId: original.id,
    change: structuredClone(original.change), status: "pending" };
}

function applyStaffChange(state: CallState, item: import("./model.ts").StaffItem,
                          change: import("./model.ts").StaffChange,
                          result: Extract<import("./model.ts").StaffChangeReceipt, { kind: "applied" }> |
                            Extract<import("./model.ts").StaffChangeObservation, { kind: "exactApplied" }>): boolean {
  const expectedStatus = change.operation === "acknowledge" ? "acknowledged" : change.operation === "resolve" ? "resolved" : "open";
  if (result.commandKey !== change.commandKey || result.taskKey !== change.taskKey ||
      result.hostTaskRef !== change.hostTaskRef || result.status !== expectedStatus ||
      JSON.stringify(result.destination) !== JSON.stringify(change.toDestination)) return false;
  const { pendingChangeKey: _pending, reviewRequired: _review, ...previous } = item;
  state.staffItems[item.key] = { ...previous, status: expectedStatus, destination: change.toDestination };
  return true;
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

function endMedia(state: CallState, now: string, reason: CallTerminalReason): void {
  state.lifecycle = "ended";
  state.terminal = { reason, at: now };
  cancelModelWork(state);
  let unresolvedTransfer = false;
  for (const [id, presentation] of Object.entries(state.presentations)) {
    if (presentation.status === "pending") state.presentations[id] = { ...presentation, status: "superseded" };
    if (presentation.status === "started" || presentation.status === "possiblySent") {
      state.presentations[id] = { ...presentation, status: "unproven" };
      unresolvedTransfer ||= presentation.kind === "transfer";
    }
  }
  delete state.pendingPresentationId;
  if (unresolvedTransfer) addStaffTask(state, "systemFailure", now);
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

  const digest = digestActionRequest(request);
  const key = createHash("sha256").update(`${state.policy.scope.tenantId}:${state.callId}:${turn.turnId}:${digest}`).digest("hex");
  const presentationId = `${key}:details`;
  const mutation = { kind: request.kind, scope: state.policy.scope, actionKey: key, payloadDigest: digest, policyVersion: state.policy.policyVersion, request };
  const action: ActionState = { key, kind: request.kind, status: "awaitingConfirmation", digest, mutation, presentationId };
  const presentation: Presentation = { kind: "speech", id: presentationId, actionKey: key, digest, approvedText: describe(request), status: "pending" };
  state.actions[key] = action;
  state.presentations[presentationId] = presentation;
  state.pendingPresentationId = presentationId;
  return ok(undefined);
}

function handleTurn(state: CallState, turn: FinalCallerTurn, interpretation: TurnInterpretation, now: string): Result<void, TransitionFailure> {
  if (state.lifecycle !== "active") return err({ kind: "invalidTransition" });
  if (state.admission && (!state.sessionLease || turn.sessionId !== state.sessionLease.sessionId || Date.parse(now) >= Date.parse(state.sessionLease.expiresAt))) return err({ kind: "leaseLost" });
  if (turn.callId !== state.callId || !turn.turnId || !turn.text || !Number.isFinite(Date.parse(turn.at))) return err({ kind: "invalidTransition" });
  if (state.processedTurnIds.includes(turn.turnId)) return ok(undefined);
  if (Object.values(state.presentations).some(presentation => presentation.kind === "transfer" && (presentation.status === "started" || presentation.status === "possiblySent"))) return err({ kind: "invalidTransition" });
  if (interpretation.kind !== "affirm") supersedeUnsent(state);
  cancelModelWork(state);
  state.conversationRevision += 1;
  const messageCount = state.callerMessages.length;

  switch (interpretation.kind) {
    case "modelPending": {
      if (!state.policy.automationEnabled || turn.quality !== "clear" || turn.turnId.length > 256 ||
          !/^[a-f0-9]{64}$/.test(interpretation.taskRef)) return err({ kind: "invalidTransition" });
      const id = `model:${interpretation.taskRef}`;
      state.effects[id] = { kind: "model", schemaVersion: 1, id, taskRef: interpretation.taskRef, turnId: turn.turnId,
        conversationRevision: state.conversationRevision, status: "pending" };
      break;
    }
    case "clarify":
      state.callerMessages.push("Could you repeat that for me?");
      break;
    case "modelFallback":
      addStaffTask(state, "systemFailure", now);
      state.callerMessages.push("I can request staff follow-up, but I can't confirm they have received it yet.");
      break;
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
    case "transfer": {
      if (turn.quality !== "clear") {
        addStaffTask(state, "verificationFailed", now);
        state.callerMessages.push("I can't confirm the transfer request safely. I'll request staff follow-up.");
      } else if (state.policy.capabilities.transfer === "execute" && state.policy.transferDestinationRef?.trim() && staffedForTransfer(state.policy, now)) {
        const id = createHash("sha256").update(JSON.stringify([state.callId, turn.turnId, state.policy.transferDestinationRef])).digest("hex");
        state.presentations[id] = { kind: "transfer", id, destinationRef: state.policy.transferDestinationRef, reason: interpretation.reason, status: "pending" };
        state.pendingPresentationId = id;
      } else if (state.policy.capabilities.transfer === "execute" && state.policy.transferDestinationRef?.trim()) {
        addStaffTask(state, interpretation.reason, now);
        state.callerMessages.push(CLOSED_TRANSFER_NOTICE);
      } else if (state.policy.capabilities.transfer === "requestOnly") {
        addStaffTask(state, interpretation.reason, now);
        state.callerMessages.push("I can request staff follow-up, but I can't confirm they've received it yet.");
      } else {
        state.callerMessages.push("I can't connect you to staff from this call.");
      }
      break;
    }
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
    case "unavailableAction":
      state.callerMessages.push("I can't complete that request here.");
      break;
    case "answer": {
      const sources = Array.isArray(interpretation.sources) ? interpretation.sources : [];
      const source = sources[0];
      if (turn.quality !== "clear" || sources.length !== 1 ||
          !validCallKnowledgeSource(source, state.policy, now) || interpretation.proposedText !== source.approvedText) {
        addStaffTask(state, "systemFailure", now);
        state.callerMessages.push("I can't verify that information right now.");
      } else {
        state.callerMessages.push(source.approvedText);
        state.knowledgeAnswers.push({ turnId: turn.turnId, sourceRef: source.sourceRef, version: source.version, ownerRef: source.ownerRef });
      }
      break;
    }
    case "knowledgeFailure":
      addStaffTask(state, "systemFailure", now);
      state.callerMessages.push("I can't verify that information right now.");
      break;
    case "availability": {
      const presentation = availabilityPresentation(interpretation.snapshot, state.policy.scope, interpretation.from, interpretation.to, now);
      if (turn.quality !== "clear" || !presentation.ok) {
        addStaffTask(state, "systemFailure", now);
        state.callerMessages.push("I can't check available times right now. I'll request staff follow-up.");
        state.availabilityReads.push({ turnId: turn.turnId, status: "failed", reason: turn.quality !== "clear" ? "unclear" : "invalidEvidence" });
      } else {
        state.callerMessages.push(presentation.value.text);
        state.availabilityReads.push({ turnId: turn.turnId, status: presentation.value.status, sourceRef: presentation.value.sourceRef,
          timeZone: presentation.value.timeZone, observedAt: presentation.value.observedAt, shownStartsAt: presentation.value.shownStartsAt });
      }
      break;
    }
    case "availabilityFailure":
      addStaffTask(state, "systemFailure", now);
      state.callerMessages.push("I can't check available times right now. I'll request staff follow-up.");
      state.availabilityReads.push({ turnId: turn.turnId, status: "failed", reason: interpretation.reason });
      break;
    case "appointments": {
      const presentation = appointmentPresentation(interpretation.snapshot, state.policy.scope, interpretation.from, interpretation.to, now);
      if (turn.quality !== "clear" || !presentation.ok) {
        addStaffTask(state, "systemFailure", now);
        state.callerMessages.push("I can't check appointments right now. I'll request staff follow-up.");
        state.appointmentReads.push({ turnId: turn.turnId, status: "failed", reason: turn.quality !== "clear" ? "unclear" : "invalidEvidence" });
      } else {
        state.callerMessages.push(presentation.value.text);
        state.appointmentReads.push({ turnId: turn.turnId, status: presentation.value.status,
          sourceRef: presentation.value.sourceRef, shownCount: presentation.value.shownCount });
      }
      break;
    }
    case "appointmentsFailure":
      addStaffTask(state, interpretation.reason === "invalidProof" || interpretation.reason === "unclear" ? "verificationFailed" : "systemFailure", now);
      state.callerMessages.push(interpretation.reason === "invalidProof" || interpretation.reason === "unclear"
        ? "I can't verify whose appointment to check. I'll request staff follow-up."
        : "I can't check appointments right now. I'll request staff follow-up.");
      state.appointmentReads.push({ turnId: turn.turnId, status: "failed", reason: interpretation.reason });
      break;
  }
  const newMessages = state.callerMessages.slice(messageCount);
  if (newMessages.length > 0 && !state.pendingPresentationId) {
    const id = createHash("sha256").update(JSON.stringify([state.callId, turn.turnId, "notice"])).digest("hex");
    state.presentations[id] = { kind: "notice", id, approvedText: newMessages.join(" "), status: "pending" };
    state.pendingPresentationId = id;
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
  if ("now" in action && action.now !== undefined && !Number.isFinite(Date.parse(action.now))) return err({ kind: "invalidTransition" });
  const state = structuredClone(current);
  const now = "now" in action && action.now !== undefined ? action.now : new Date(0).toISOString();

  switch (action.kind) {
    case "sessionActivated": {
      if (state.lifecycle !== "starting" || !state.admission || !action.sessionId) return err({ kind: "invalidTransition" });
      if (Date.parse(action.now) >= Date.parse(state.admission.deadline)) return err({ kind: "admissionExpired" });
      state.lifecycle = "active";
      state.sessionLease = { sessionId: action.sessionId, version: 1, expiresAt: new Date(Date.parse(action.now) + 30_000).toISOString(), validForMs: 30_000 };
      break;
    }
    case "sessionRenewed": {
      const lease = state.sessionLease;
      if (state.lifecycle !== "active" || !lease || lease.sessionId !== action.sessionId || Date.parse(action.now) >= Date.parse(lease.expiresAt)) return err({ kind: "leaseLost" });
      if (lease.version > 1 && action.expectedLeaseVersion === lease.version - 1) {
        return ok({ ...current, sessionLease: { ...lease, validForMs: Date.parse(lease.expiresAt) - Date.parse(action.now) } });
      }
      if (lease.version !== action.expectedLeaseVersion) return err({ kind: "leaseLost" });
      state.sessionLease = { sessionId: lease.sessionId, version: lease.version + 1, expiresAt: new Date(Date.parse(action.now) + 30_000).toISOString(), validForMs: 30_000 };
      break;
    }
    case "admissionExpired": {
      if (state.lifecycle !== "starting" || !state.admission || Date.parse(action.now) < Date.parse(state.admission.deadline)) return err({ kind: "invalidTransition" });
      endMedia(state, now, "admissionExpired");
      break;
    }
    case "sessionExpired": {
      const lease = state.sessionLease;
      if (state.lifecycle !== "active" || !lease || lease.sessionId !== action.sessionId || lease.version !== action.expectedLeaseVersion || Date.parse(action.now) < Date.parse(lease.expiresAt)) return err({ kind: "leaseLost" });
      endMedia(state, now, "leaseExpired");
      break;
    }
    case "callEnded": {
      if (!["callerDisconnected", "sessionClosed", "mediaFailure", "localLeaseClosed"].includes(action.reason)) return err({ kind: "invalidTransition" });
      if (state.lifecycle !== "active" || state.sessionLease?.sessionId !== action.sessionId) return err({ kind: "leaseLost" });
      endMedia(state, now, action.reason);
      break;
    }
    case "speechBegan": {
      if (state.lifecycle !== "active" || !state.admission || !state.sessionLease || state.sessionLease.sessionId !== action.sessionId || Date.parse(action.now) >= Date.parse(state.sessionLease.expiresAt)) return err({ kind: "leaseLost" });
      const pendingId = state.pendingPresentationId;
      if (pendingId && state.presentations[pendingId]?.status === "pending") {
        state.presentations[pendingId] = { ...state.presentations[pendingId]!, status: "superseded" };
        delete state.pendingPresentationId;
      }
      for (const [key, candidate] of Object.entries(state.actions)) {
        const presentation = state.presentations[candidate.presentationId];
        if (candidate.status === "awaitingConfirmation" && presentation && (presentation.status === "started" || presentation.status === "superseded")) {
          state.actions[key] = { ...candidate, status: "canceled" };
        }
      }
      state.conversationRevision += 1;
      cancelModelWork(state);
      break;
    }
    case "callerTurn": {
      if (current.processedTurnIds.includes(action.turn.turnId)) {
        return current.processedTurnDigests[action.turn.turnId] === turnDigest(action.turn, action.interpretation)
          ? ok(current) : err({ kind: "keyMismatch" });
      }
      if (action.expectedConversationRevision !== undefined && action.expectedConversationRevision !== current.conversationRevision) return err({ kind: "staleTurn" });
      const result = handleTurn(state, action.turn, action.interpretation, now);
      if (!result.ok) return result;
      break;
    }
    case "modelResolved": {
      const result = acceptModelResult(state, action, now);
      if (!result.ok) return result;
      if (!result.value) return ok(current);
      break;
    }
    case "modelKnowledgeResolved": {
      const result = acceptModelKnowledge(state, action, now);
      if (!result.ok) return result;
      if (!result.value) return ok(current);
      break;
    }
    case "presentationStarted": {
      if (state.lifecycle !== "active") return err({ kind: "invalidTransition" });
      if (state.admission && (!state.sessionLease || action.sessionId !== state.sessionLease.sessionId || !action.now || Date.parse(action.now) >= Date.parse(state.sessionLease.expiresAt))) return err({ kind: "leaseLost" });
      const presentation = state.presentations[action.presentationId];
      if (!presentation || presentation.status !== "pending" || state.pendingPresentationId !== presentation.id) return err({ kind: "invalidTransition" });
      if (Object.values(state.presentations).some(other => other.id !== presentation.id && (other.status === "started" || other.status === "possiblySent"))) return err({ kind: "invalidTransition" });
      state.presentations[presentation.id] = { ...presentation, status: "started" };
      delete state.pendingPresentationId;
      break;
    }
    case "transferPossiblySent": {
      if (state.lifecycle !== "active" || !state.admission || !state.sessionLease || state.sessionLease.sessionId !== action.sessionId || Date.parse(action.now) >= Date.parse(state.sessionLease.expiresAt)) return err({ kind: "leaseLost" });
      const presentation = state.presentations[action.presentationId];
      if (!presentation || presentation.kind !== "transfer" || presentation.status !== "started") return err({ kind: "invalidTransition" });
      if (!staffedForTransfer(state.policy, now)) {
        state.presentations[presentation.id] = { ...presentation, status: "canceled" };
        addStaffTask(state, presentation.reason, now);
        const noticeId = `${presentation.id}:closedNotice`;
        state.presentations[noticeId] = { kind: "notice", id: noticeId, approvedText: CLOSED_TRANSFER_NOTICE, status: "pending" };
        state.pendingPresentationId = noticeId;
        state.callerMessages.push(CLOSED_TRANSFER_NOTICE);
        break;
      }
      state.presentations[presentation.id] = { ...presentation, status: "possiblySent" };
      break;
    }
    case "presentationResolved": {
      if (state.lifecycle !== "active") return err({ kind: "invalidTransition" });
      if (state.admission && (!state.sessionLease || action.sessionId !== state.sessionLease.sessionId || !action.now || Date.parse(action.now) >= Date.parse(state.sessionLease.expiresAt))) return err({ kind: "leaseLost" });
      const presentation = state.presentations[action.presentationId];
      if (!presentation || (presentation.status !== "started" && presentation.status !== "possiblySent")) return err({ kind: "invalidTransition" });
      if (presentation.kind === "transfer") {
        if (action.status !== "connected" && action.status !== "failed" && action.status !== "unproven" && action.status !== "canceled") return err({ kind: "invalidTransition" });
        if (action.status === "canceled" ? presentation.status !== "started" : presentation.status !== "possiblySent") return err({ kind: "invalidTransition" });
        if (action.status === "connected") {
          if (!action.providerConnectionRef?.trim()) return err({ kind: "invalidTransition" });
          state.presentations[presentation.id] = { ...presentation, status: "connected", providerConnectionRef: action.providerConnectionRef };
          endMedia(state, now, "transferConnected");
        } else {
          state.presentations[presentation.id] = { ...presentation, status: action.status };
          if (action.status === "failed") {
            addStaffTask(state, "transferFailed", now);
            const noticeId = `${presentation.id}:failureNotice`;
            const approvedText = "I couldn't connect you. I'll request staff follow-up, but I can't confirm they've received it yet.";
            state.presentations[noticeId] = { kind: "notice", id: noticeId, approvedText, status: "pending" };
            state.pendingPresentationId = noticeId;
            state.callerMessages.push(approvedText);
          } else if (action.status === "unproven") {
            addStaffTask(state, "systemFailure", now);
            endMedia(state, now, "transferUnproven");
          }
        }
      } else {
        if (action.status !== "played" && action.status !== "interrupted" && action.status !== "failed" && action.status !== "unproven") return err({ kind: "invalidTransition" });
        state.presentations[presentation.id] = { ...presentation, status: action.status };
      }
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
    case "hostWriteBlocked": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "hostWrite") return err({ kind: "effectUnknown" });
      const pendingAction = state.actions[effect.actionKey];
      if (effect.status !== "pending" || pendingAction?.status !== "ready" || pendingAction.digest !== effect.mutation.payloadDigest) return err({ kind: "invalidTransition" });
      state.effects[effect.id] = { ...effect, status: "canceled" };
      state.actions[pendingAction.key] = { ...pendingAction, status: "unsupported" };
      addStaffTask(state, "emergencyStopped", action.now, pendingAction.key, effect.mutation.request);
      const approvedText = "I can't complete that action now. I'll request staff follow-up, but I can't confirm they've received it yet.";
      state.callerMessages.push(approvedText);
      if (state.lifecycle === "active" && !state.pendingPresentationId) {
        const id = `${effect.id}:stoppedNotice`;
        state.presentations[id] = { kind: "notice", id, approvedText, status: "pending" };
        state.pendingPresentationId = id;
      }
      break;
    }
    case "recoverHostPossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "hostWrite") return err({ kind: "effectUnknown" });
      if (effect.status === "uncertain") return ok(current);
      if (effect.status !== "possiblySent" || !effect.possiblySentAt || Date.parse(now) < Date.parse(effect.possiblySentAt) + POSSIBLE_SEND_RECOVERY_DELAY_MS) return err({ kind: "invalidTransition" });
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
      if (effect.status !== "possiblySent" || !effect.possiblySentAt || Date.parse(now) < Date.parse(effect.possiblySentAt) + POSSIBLE_SEND_RECOVERY_DELAY_MS) return err({ kind: "invalidTransition" });
      const item = state.staffItems[effect.taskKey];
      if (!item) return err({ kind: "invalidTransition" });
      queueStaffReconciliation(state, effect.id, item);
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
        if (action.receipt.kind === "uncertain") queueStaffReconciliation(state, effect.id, item);
        state.staffItems[item.key] = { ...item, status: "needsReview", destination: state.policy.operatorQueue };
        state.effects[effect.id] = { ...effect, status: action.receipt.kind === "uncertain" ? "uncertain" : "completed" };
      }
      break;
    }
    case "staffTaskReconciled": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "staffReconcile" || effect.status !== "pending") return err({ kind: "invalidTransition" });
      if (!["exactOpen", "definitiveNonOpen", "stillUnknown"].includes(action.observation.kind)) return err({ kind: "invalidTransition" });
      if (effect.taskKey !== action.observation.taskKey) return err({ kind: "keyMismatch" });
      const original = state.effects[effect.originalEffectId];
      const item = state.staffItems[effect.taskKey];
      if (!original || original.kind !== "staffTask" || original.status !== "uncertain" || !item || item.status !== "needsReview") return err({ kind: "invalidTransition" });
      if (action.observation.kind === "exactOpen") {
        if (typeof action.observation.hostTaskRef !== "string" || !action.observation.hostTaskRef.trim() ||
            JSON.stringify(action.observation.destination) !== JSON.stringify(effect.originalItem.destination)) return err({ kind: "invalidTransition" });
        state.staffItems[item.key] = { ...item, status: "open", destination: effect.originalItem.destination, hostTaskRef: action.observation.hostTaskRef };
      }
      if (action.observation.kind !== "stillUnknown") state.effects[original.id] = { ...original, status: "completed" };
      state.effects[effect.id] = { ...effect, status: "completed" };
      break;
    }
    case "staffChangeRequested": {
      const planned = planStaffChange(state, action.taskKey, action.actorRef, action.change);
      if (!planned.ok) return planned;
      state.staffItems[action.taskKey] = planned.value.item;
      state.effects[planned.value.effect.id] = planned.value.effect;
      break;
    }
    case "markStaffChangePossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "staffChange" || effect.status !== "pending") return err({ kind: "invalidTransition" });
      const item = state.staffItems[effect.taskKey];
      if (!item || item.pendingChangeKey !== effect.change.commandKey || item.status !== effect.change.fromStatus ||
          JSON.stringify(item.destination) !== JSON.stringify(effect.change.fromDestination)) return err({ kind: "invalidTransition" });
      state.effects[effect.id] = { ...effect, status: "possiblySent", possiblySentAt: now };
      break;
    }
    case "recoverStaffChangePossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "staffChange") return err({ kind: "effectUnknown" });
      if (effect.status === "uncertain") return ok(current);
      if (effect.status !== "possiblySent" || !effect.possiblySentAt ||
          Date.parse(now) < Date.parse(effect.possiblySentAt) + POSSIBLE_SEND_RECOVERY_DELAY_MS) return err({ kind: "invalidTransition" });
      const item = state.staffItems[effect.taskKey];
      if (!item || item.pendingChangeKey !== effect.change.commandKey) return err({ kind: "invalidTransition" });
      queueStaffChangeReconciliation(state, effect);
      state.staffItems[item.key] = { ...item, reviewRequired: true };
      state.effects[effect.id] = { ...effect, status: "uncertain" };
      break;
    }
    case "staffChangeResolved": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "staffChange" || effect.status !== "possiblySent") return err({ kind: "invalidTransition" });
      const item = state.staffItems[effect.taskKey];
      const receipt = action.receipt;
      if (!item || item.pendingChangeKey !== effect.change.commandKey ||
          receipt.commandKey !== effect.change.commandKey || receipt.taskKey !== effect.taskKey) return err({ kind: "keyMismatch" });
      if (receipt.kind === "applied") {
        if (!applyStaffChange(state, item, effect.change, receipt)) return err({ kind: "invalidTransition" });
        state.effects[effect.id] = { ...effect, status: "completed" };
      } else if (receipt.kind === "rejected") {
        const { pendingChangeKey: _pending, ...previous } = item;
        state.staffItems[item.key] = { ...previous, reviewRequired: true };
        state.effects[effect.id] = { ...effect, status: "completed" };
      } else if (receipt.kind === "uncertain") {
        queueStaffChangeReconciliation(state, effect);
        state.staffItems[item.key] = { ...item, reviewRequired: true };
        state.effects[effect.id] = { ...effect, status: "uncertain" };
      } else return err({ kind: "invalidTransition" });
      break;
    }
    case "staffChangeReconciled": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "staffChangeReconcile" || effect.status !== "pending") return err({ kind: "invalidTransition" });
      const original = state.effects[effect.originalEffectId];
      const item = state.staffItems[effect.taskKey];
      const observation = action.observation;
      if (!original || original.kind !== "staffChange" || original.status !== "uncertain" || !item ||
          item.pendingChangeKey !== effect.change.commandKey || observation.commandKey !== effect.change.commandKey ||
          observation.taskKey !== effect.taskKey) return err({ kind: "keyMismatch" });
      if (observation.kind === "exactApplied") {
        if (!applyStaffChange(state, item, effect.change, observation)) return err({ kind: "invalidTransition" });
        state.effects[original.id] = { ...original, status: "completed" };
      } else if (observation.kind === "definitiveNonApplied") {
        const { pendingChangeKey: _pending, ...previous } = item;
        state.staffItems[item.key] = { ...previous, reviewRequired: true };
        state.effects[original.id] = { ...original, status: "completed" };
      } else if (observation.kind !== "stillUnknown") return err({ kind: "invalidTransition" });
      state.effects[effect.id] = { ...effect, status: "completed" };
      break;
    }
    case "staffAlertRequested": {
      if (action.reason !== "overdue" && action.reason !== "needsReview") return err({ kind: "invalidTransition" });
      const item = state.staffItems[action.taskKey];
      if (!item) return err({ kind: "invalidTransition" });
      const id = `${item.key}:alert:${action.reason}`;
      if (!alertable(item, action.reason, now) || state.effects[id]) return ok(current);
      const destination = state.policy.operatorQueue;
      if (!destination || (destination.kind === "queue" ? !destination.queueRef.trim() : !destination.ownerRef.trim())) return err({ kind: "invalidTransition" });
      state.effects[id] = { kind: "operatorAlert", id, status: "pending", alert: { alertKey: id, callId: state.callId, taskKey: item.key,
        scope: state.policy.scope, reason: action.reason, destination, dueAt: item.dueAt } };
      setAlertState(state, item.key, action.reason, "pending");
      break;
    }
    case "markOperatorAlertPossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "operatorAlert" || effect.status !== "pending") return err({ kind: "invalidTransition" });
      const item = state.staffItems[effect.alert.taskKey];
      if (!item || !sameScope(item.scope, effect.alert.scope)) return err({ kind: "invalidTransition" });
      if (!alertable(item, effect.alert.reason, now)) {
        state.effects[effect.id] = { ...effect, status: "canceled" };
        setAlertState(state, item.key, effect.alert.reason, "canceled");
      } else {
        state.effects[effect.id] = { ...effect, status: "possiblySent", possiblySentAt: now };
      }
      break;
    }
    case "recoverOperatorAlertPossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "operatorAlert") return err({ kind: "effectUnknown" });
      if (effect.status === "uncertain") return ok(current);
      if (effect.status !== "possiblySent" || !effect.possiblySentAt || Date.parse(now) < Date.parse(effect.possiblySentAt) + POSSIBLE_SEND_RECOVERY_DELAY_MS) return err({ kind: "invalidTransition" });
      const item = state.staffItems[effect.alert.taskKey];
      if (!item) return err({ kind: "invalidTransition" });
      const reconcileId = `${effect.id}:reconcile`;
      state.effects[reconcileId] = { kind: "operatorAlertReconcile", id: reconcileId, alert: effect.alert, originalEffectId: effect.id, status: "pending" };
      state.effects[effect.id] = { ...effect, status: "uncertain" };
      setAlertState(state, item.key, effect.alert.reason, "uncertain");
      break;
    }
    case "operatorAlertResolved": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "operatorAlert" || effect.status !== "possiblySent") return err({ kind: "invalidTransition" });
      if (action.receipt.alertKey !== effect.alert.alertKey || !["delivered", "failed", "uncertain"].includes(action.receipt.kind)) return err({ kind: "keyMismatch" });
      const item = state.staffItems[effect.alert.taskKey];
      if (!item) return err({ kind: "invalidTransition" });
      if (action.receipt.kind === "uncertain") {
        const reconcileId = `${effect.id}:reconcile`;
        state.effects[reconcileId] = { kind: "operatorAlertReconcile", id: reconcileId, alert: effect.alert, originalEffectId: effect.id, status: "pending" };
        state.effects[effect.id] = { ...effect, status: "uncertain" };
      } else state.effects[effect.id] = { ...effect, status: "completed" };
      setAlertState(state, item.key, effect.alert.reason, action.receipt.kind);
      break;
    }
    case "operatorAlertReconciled": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "operatorAlertReconcile" || effect.status !== "pending") return err({ kind: "invalidTransition" });
      const original = state.effects[effect.originalEffectId];
      const item = state.staffItems[effect.alert.taskKey];
      if (!original || original.kind !== "operatorAlert" || original.status !== "uncertain" || !item ||
          action.observation.alertKey !== effect.alert.alertKey ||
          !["exactDelivered", "definitiveNotDelivered", "stillUnknown"].includes(action.observation.kind)) return err({ kind: "keyMismatch" });
      if (action.observation.kind !== "stillUnknown") state.effects[original.id] = { ...original, status: "completed" };
      state.effects[effect.id] = { ...effect, status: "completed" };
      setAlertState(state, item.key, effect.alert.reason, action.observation.kind === "exactDelivered" ? "delivered" :
        action.observation.kind === "definitiveNotDelivered" ? "failed" : "uncertain");
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
  redactSettledContent(state);
  state.version = current.version + 1;
  return ok(state);
}
