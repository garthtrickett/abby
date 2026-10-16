import { previousPractitionerText, previousPractitionerUnavailable } from "./previous-practitioner.ts";
import { bookingServiceQuestionText } from "./booking-service-question.ts";
import { classServiceQuestionText } from "./class-service-question.ts";
import { staffMessageNoticeText, validStaffMessageNotice } from "./staff-message-notice.ts";
import { conversationControl, conversationControlText, validConversationControlNotice } from "./conversation-control.ts";
import { reschedulingMenuPresentation } from "./rescheduling-menu.ts";
import { bookingConfirmation, bookingMenuPresentation } from "./booking-menu.ts";
import { supportedVoiceLocale } from "./voice-presentation.ts";
import { createHash } from "node:crypto";
import { digestActionRequest } from "./digest.ts";
import { clearAffirmation } from "./caller-affirmation.ts";
import { actionOutcomeText, confirmedActionText } from "./action-outcome.ts";
import { classMovementOutcomeText, readClassMovementReceipt, stopClassMovement, uncertainClassMovement } from "./class-movement-continuation.ts";
import { classMovementConsentText, readClassMovementConsent } from "./class-movement-consent.ts";
import { patientCorrectionEvidenceFailure } from "./patient-correction.ts";
import { confirmationResendEvidenceFailure } from "./confirmation-resend.ts";
import { requestBoundaryText, validRequestBoundary } from "./request-boundary.ts";
import { completedAppointmentEnquiry } from "./completed-appointment-enquiry.ts";
import { noticePresentationId } from "./notice-presentation-id.ts";
export { noticePresentationId } from "./notice-presentation-id.ts";
import { bookingHorizonText, validBookingHorizon } from "./booking-horizon.ts";
import { publicInformationUnavailable } from "./public-information.ts";
import { conversationPresenceText } from "./conversation-presence.ts";
import { missedCallText } from "./missed-call.ts";
import { staffSubjectUnavailable, staffRequestSubjectLabel, staffRequestSubjectLimit, validStaffRequestSubject } from "./staff-request-subject.ts";
import { callerIdentityDenialText, restrictDeniedCaller, validCallerIdentityDenial } from "./caller-identity.ts";
import { notificationOutcomeText } from "./notification-outcome.ts";
import { clarificationText } from "./clarification.ts";
import { notificationDirective, queueCommittedNotification, transitionNotification } from "./notification-effects.ts";
import { availabilityPresentation } from "./availability-presentation.ts";
import { appointmentPresentation } from "./appointment-presentation.ts";
import { addStaffTask, planStaffChange } from "./staff-work.ts";
import { staffFallbackText, staffRequestNotice } from "./staff-fallback.ts";
import { staffOutcomeText, staffUnavailableText, validStaffLabel } from "./staff-outcome.ts";
import { staffedForTransfer, staffingWindowStatus } from "./staffed-window.ts";
import { approvedAfterHoursText } from "./after-hours-policy.ts";
import { urgentHandoffNotice } from "./urgent-response.ts";
import { SILENCE_FINAL_NOTICE, SILENCE_RETRY_NOTICE } from "./silence-notices.ts";
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
const UNKNOWN_TRANSFER_NOTICE = "I can't confirm whether staff are available for a live transfer now. I'll request follow-up, but I can't confirm they've received it yet.";

function transferUnavailableNotice(state: CallState, now: string): string {
  const status = staffingWindowStatus(state.policy, now);
  const approvedInfo = status === "closed" ? approvedAfterHoursText(state.policy) : undefined;
  const notice = status === "closed" ? CLOSED_TRANSFER_NOTICE : UNKNOWN_TRANSFER_NOTICE;
  return staffFallbackText(state, approvedInfo ? `${notice} ${approvedInfo}` : notice);
}

function hostOutcomeNotice(state: CallState, effectId: string, approvedText: string): void {
  if (state.callerIdentityDenied) return;
  state.callerMessages.push(approvedText);
  if (state.lifecycle !== "active" || state.pendingPresentationId) return;
  const id = `${effectId}:resultNotice`;
  state.presentations[id] = { kind: "notice", id, approvedText, status: "pending" };
  state.pendingPresentationId = id;
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function appointmentTime(instant: string, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "long" }).format(new Date(instant));
}

function describe(request: ActionRequest, locale: string): string {
  switch (request.kind) {
    case "book": { const confirmed = bookingConfirmation(request.offer, locale); return confirmed.ok ? confirmed.value : ""; }
    case "cancel": return `Please confirm cancellation of your appointment on ${appointmentTime(request.target.startsAt, request.target.timeZone, locale)}. ${request.terms.approvedText}`;
    case "reschedule": {
      const detail = request.offer.presentation;
      if (detail && !bookingConfirmation(request.offer, locale).ok) return "";
      if (request.serviceChange && detail) return `Please confirm moving your ${request.serviceChange.fromServiceName} appointment on ${appointmentTime(request.target.startsAt, request.target.timeZone, locale)} to ${detail.appointmentTypeName} with ${detail.practitionerName} on ${appointmentTime(request.offer.startsAt, request.target.timeZone, locale)}, for ${detail.durationMinutes} minutes. ${request.terms.approvedText}`;
      if (request.practitionerChange && detail) {
        const original = appointmentTime(request.target.startsAt, request.target.timeZone, locale);
        return Date.parse(request.offer.startsAt) === Date.parse(request.target.startsAt)
          ? `Please confirm changing the practitioner for your ${detail.appointmentTypeName} appointment on ${original} to ${detail.practitionerName}. ${request.terms.approvedText}`
          : `Please confirm moving your ${detail.appointmentTypeName} appointment on ${original} to ${appointmentTime(request.offer.startsAt, request.target.timeZone, locale)} with ${detail.practitionerName}, for ${detail.durationMinutes} minutes. ${request.terms.approvedText}`;
      }
      return `Please confirm moving your ${detail ? `${detail.appointmentTypeName} appointment with ${detail.practitionerName}` : "appointment"} on ${appointmentTime(request.target.startsAt, request.target.timeZone, locale)} to ${appointmentTime(request.offer.startsAt, request.target.timeZone, locale)}${detail ? `, for ${detail.durationMinutes} minutes` : ""}. ${request.terms.approvedText}`;
    }
    case "intake": return "Please confirm that your approved intake details may be saved. This does not book an appointment.";
    case "patientUpdate": return "Please confirm saving the patient-detail correction that was read back privately. Your appointments will remain unchanged.";
    case "confirmationResend": return "Please confirm sending the appointment-details email to the verified recipient read back privately.";
  }
}

function requestScope(request: ActionRequest): LocationScope {
  return request.kind === "intake" || request.kind === "confirmationResend" ? request.scope : request.patient.scope;
}

/** Shared check for a host-issued appointment change before speech and again before dispatch. */
export function appointmentChangeEvidenceFailure(scope: LocationScope,
  request: Extract<ActionRequest, { kind: "cancel" | "reschedule" }>, now: string): TransitionFailure | undefined {
  if (!request.patient || !request.target || !request.terms ||
      typeof request.patient !== "object" || typeof request.target !== "object" ||
      typeof request.terms !== "object") return { kind: "invalidTransition" };
  if (!request.patient.scope || !request.target.scope || !sameScope(scope, request.patient.scope) ||
      !sameScope(scope, request.target.scope) || request.target.patientRef !== request.patient.patientRef ||
      (request.kind === "reschedule" && (!request.offer?.scope || !sameScope(scope, request.offer.scope)))) {
    return { kind: "scopeMismatch" };
  }
  const current = Date.parse(now);
  const proofExpiry = Date.parse(request.patient.expiresAt);
  const offerExpiry = request.kind === "reschedule" ? Date.parse(request.offer.expiresAt) : Infinity;
  const termsExpiry = Date.parse(request.terms.expiresAt);
  if (!Number.isFinite(current) || !Number.isFinite(proofExpiry) ||
      (request.kind === "reschedule" && !Number.isFinite(offerExpiry)) || !Number.isFinite(termsExpiry)) {
    return { kind: "invalidTransition" };
  }
  if (proofExpiry <= current || offerExpiry <= current || termsExpiry <= current) return { kind: "evidenceExpired" };
  const start = Date.parse(request.target.startsAt);
  const end = Date.parse(request.target.endsAt);
  const newStart = request.kind === "reschedule" ? Date.parse(request.offer.startsAt) : undefined;
  if (typeof request.target.appointmentRef !== "string" || !request.target.appointmentRef.trim() ||
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      typeof request.target.timeZone !== "string" || !request.target.timeZone.trim() || request.target.timeZone.length > 128 ||
      typeof request.terms.version !== "string" || !request.terms.version.trim() || request.terms.version.length > 256 ||
      typeof request.terms.approvedText !== "string" || !request.terms.approvedText.trim() ||
      request.terms.approvedText.length > 500 || /[\u0000-\u001f\u007f]/.test(request.terms.approvedText) ||
      (request.kind === "reschedule" && (!Number.isFinite(newStart) || newStart === start && request.practitionerChange !== true && request.serviceChange === undefined))) {
    return { kind: "invalidTransition" };
  }
  if (request.kind === "reschedule" && request.practitionerChange !== undefined && (request.practitionerChange !== true || !request.offer.presentation)) return { kind: "invalidTransition" };
  if (request.kind === "reschedule" && request.serviceChange !== undefined && (!request.serviceChange || typeof request.serviceChange !== "object" || Array.isArray(request.serviceChange) ||
      Object.keys(request.serviceChange).join(",") !== "fromServiceName" || typeof request.serviceChange.fromServiceName !== "string" ||
      !request.serviceChange.fromServiceName || request.serviceChange.fromServiceName.trim() !== request.serviceChange.fromServiceName || request.serviceChange.fromServiceName.length > 120 ||
      !/^[\p{L}\p{M}\p{N} .,'()&/-]+$/u.test(request.serviceChange.fromServiceName) || !request.offer.presentation)) return { kind: "invalidTransition" };
  if (request.kind === "reschedule" && request.offer.presentation &&
      (!bookingConfirmation(request.offer, "en-AU").ok || request.offer.presentation.timeZone !== request.target.timeZone ||
       request.offer.presentation.durationMinutes*60_000 !== end-start && request.serviceChange === undefined)) return { kind: "invalidTransition" };
  try { appointmentTime(request.target.startsAt, request.target.timeZone, "en-AU"); }
  catch { return { kind: "invalidTransition" }; }
  return undefined;
}

function evidenceFailure(state: CallState, request: ActionRequest, now: string): TransitionFailure | undefined {
  if (request.kind === "patientUpdate") return patientCorrectionEvidenceFailure(state.policy.scope, request, now);
  if (request.kind === "confirmationResend") return confirmationResendEvidenceFailure(state.policy, request, now);
  if (request.kind === "cancel" || request.kind === "reschedule") {
    return appointmentChangeEvidenceFailure(state.policy.scope, request, now);
  }
  if (!sameScope(state.policy.scope, requestScope(request))) return { kind: "scopeMismatch" };
  if (request.kind === "intake") {
    if ((request.recoveryContract !== undefined && request.recoveryContract !== "callerMediated") || !request.approvedDraftRef || !request.consentRef || !request.duplicateCheckRef) return { kind: "invalidTransition" };
    return undefined;
  }
  if (Date.parse(request.patient.expiresAt) <= Date.parse(now)) return { kind: "evidenceExpired" };
  if (request.kind === "book") {
    if (!sameScope(state.policy.scope, request.offer.scope)) return { kind: "scopeMismatch" };
    if (!bookingConfirmation(request.offer, state.policy.voiceProfile?.locale ?? "en-AU").ok) return { kind: "invalidTransition" };
    if (Date.parse(request.offer.expiresAt) <= Date.parse(now)) return { kind: "evidenceExpired" };
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

function retireClassMovementAction(state: CallState, action: ActionState): void {
  if (!action.classMovement) return;
  const possibleSend = Object.values(state.effects).some(effect => effect.kind === "hostWrite" && effect.actionKey === action.key && effect.status === "possiblySent");
  const movement = possibleSend ? uncertainClassMovement(action.classMovement) : stopClassMovement(action.classMovement);
  const { classMovementConsent: _retiredConsent, ...remaining } = action;
  state.actions[action.key] = { ...remaining, classMovement: movement,
    status: movement.outcome === "moved" ? "committed" : movement.outcome === "restored" ? "rejected" : "needsReview" };
  for (const [id, effect] of Object.entries(state.effects)) {
    if (effect.kind === "hostWrite" && effect.actionKey === action.key && effect.status === "pending")
      state.effects[id] = { ...effect, status: "canceled" };
  }
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
    if (action.classMovement && action.status === "dispatched") {
      retireClassMovementAction(state, action); continue;
    }
    if (action.status !== "awaitingConfirmation" && action.status !== "ready") continue;
    const presentation = state.presentations[action.presentationId];
    if (presentation && presentation.status !== "played") {
      state.presentations[presentation.id] = { ...presentation, status: "superseded" };
    }
    if (action.classMovement) { retireClassMovementAction(state, action); continue; }
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
  for (const action of Object.values(state.actions)) {
    if (action.classMovement?.outcome === "pending")
      retireClassMovementAction(state, action);
  }
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
  const mode = state.policy.capabilities[request.kind] ?? "unavailable";
  if (mode === "unavailable" || request.kind === "confirmationResend" && mode !== "execute") {
    state.callerMessages.push("I can't complete that request here.");
    return ok(undefined);
  }
  if (mode === "requestOnly") {
    addStaffTask(state, "unsupported", now, undefined, request);
    state.callerMessages.push(staffRequestNotice(state));
    return ok(undefined);
  }

  const locale = state.policy.voiceProfile?.locale ?? "en-AU";
  if (!supportedVoiceLocale(locale)) return err({ kind: "invalidTransition" });
  const digest = digestActionRequest(request);
  const key = createHash("sha256").update(`${state.policy.scope.tenantId}:${state.callId}:${turn.turnId}:${digest}`).digest("hex");
  const presentationId = `${key}:details`;
  const notification = notificationDirective(state.policy, state.callId, key, request.kind);
  const mutation = { kind: request.kind, scope: state.policy.scope, actionKey: key, payloadDigest: digest,
    policyVersion: state.policy.policyVersion, request, ...(notification ? { notification } : {}) };
  const action: ActionState = { key, kind: request.kind, status: "awaitingConfirmation", digest, mutation, presentationId };
  const presentation: Presentation = { kind: "speech", id: presentationId, actionKey: key, digest, approvedText: describe(request, locale), status: "pending" };
  state.actions[key] = action;
  state.presentations[presentationId] = presentation;
  state.pendingPresentationId = presentationId;
  return ok(undefined);
}

function prepareClassMovementConsent(state: CallState, actionKey: string,
  evidence: import("./class-movement-consent.ts").ClassMovementConsentEvidence, now: string): Result<void, TransitionFailure> {
  const target = state.actions[actionKey];
  if (!target || target.status !== "pendingContinuation" || state.pendingPresentationId ||
      Object.values(state.presentations).some(item => item.status === "started" || item.status === "possiblySent") ||
      Object.values(state.actions).some(item => item.key !== target.key && ["awaitingConfirmation", "ready", "dispatched"].includes(item.status))) return err({ kind: "invalidTransition" });
  const consent = readClassMovementConsent(state, target, evidence, now);
  if (!consent) return err({ kind: "confirmationMissing" });
  const id = `${target.key}:classStage:${consent.digest}:confirmation`;
  if (state.presentations[id]) return err({ kind: "invalidTransition" });
  state.actions[target.key] = { ...target, status: "awaitingConfirmation", presentationId: id,
    classMovementConsent: { ...consent, presentationId: id } };
  const request = target.mutation.request;
  if (request.kind !== "reschedule") return err({ kind: "invalidTransition" });
  const locale = state.policy.voiceProfile?.locale ?? "en-AU", details = request.offer.presentation;
  const context = `The original class is on ${appointmentTime(request.target.startsAt, request.target.timeZone, locale)}. The replacement${details ? ` ${details.appointmentTypeName} with ${details.practitionerName}, for ${details.durationMinutes} minutes,` : " class"} is on ${appointmentTime(request.offer.startsAt, request.target.timeZone, locale)}. ${request.terms.approvedText}`;
  const approvedText = `${classMovementOutcomeText(target.classMovement!)} ${context} ${classMovementConsentText(consent)}`;
  state.presentations[id] = { kind: "speech", id, actionKey: target.key, digest: consent.digest, approvedText, status: "pending" };
  state.pendingPresentationId = id;
  return ok(undefined);
}

function handleTurn(state: CallState, turn: FinalCallerTurn, interpretation: TurnInterpretation, now: string): Result<void, TransitionFailure> {
  if (state.lifecycle !== "active") return err({ kind: "invalidTransition" });
  if (state.admission && (!state.sessionLease || turn.sessionId !== state.sessionLease.sessionId || Date.parse(now) >= Date.parse(state.sessionLease.expiresAt))) return err({ kind: "leaseLost" });
  if (turn.callId !== state.callId || !turn.turnId || !turn.text || !Number.isFinite(Date.parse(turn.at))) return err({ kind: "invalidTransition" });
  if (state.processedTurnIds.includes(turn.turnId)) return ok(undefined);
  if (Object.values(state.presentations).some(presentation => presentation.kind === "transfer" && (presentation.status === "started" || presentation.status === "possiblySent"))) return err({ kind: "invalidTransition" });
  if (interpretation.kind === "requestBoundary" && (!validRequestBoundary(interpretation.reason) || turn.quality !== "clear")) return err({ kind: "invalidTransition" });
  if (interpretation.kind === "callerIdentityDenied" && (!validCallerIdentityDenial(interpretation.reason) || turn.quality !== "clear")) return err({ kind: "invalidTransition" });
  if (interpretation.kind === "conversationControl" && (turn.quality !== "clear" || !validConversationControlNotice(interpretation.notice) ||
      conversationControl(turn.text) !== (interpretation.notice === "pauseLimit" ? "pause" : interpretation.notice))) return err({ kind: "invalidTransition" });
  if (interpretation.kind === "workflowStarted" && interpretation.advanceTask !== undefined) {
    const current = Object.values(state.actions).filter(action => !state.previousTaskActionKeys?.includes(action.key));
    if (interpretation.advanceTask !== true || turn.quality !== "clear" || state.pendingPresentationId ||
        (!current.some(action => action.status !== "canceled") && !completedAppointmentEnquiry(state)) || current.some(action => !["committed", "rejected", "unsupported", "canceled"].includes(action.status)) ||
        Object.values(state.effects).some(effect => (effect.kind === "hostWrite" || effect.kind === "staffTask") && !["completed", "canceled"].includes(effect.status))) return err({ kind: "invalidTransition" });
  }
  interpretation = restrictDeniedCaller(state, interpretation);
  if (interpretation.kind !== "affirm" && interpretation.kind !== "confirmationWait" && interpretation.kind !== "classMovementAffirm") supersedeUnsent(state);
  cancelModelWork(state);
  state.conversationRevision += 1;
  const messageCount = state.callerMessages.length;

  switch (interpretation.kind) {
    case "classMovementPreparation": {
      const target = state.actions[interpretation.actionKey];
      if (turn.quality !== "clear" || !target || target.status !== "pendingContinuation" || target.classMovement?.outcome !== "pending" ||
          state.pendingPresentationId || !state.policy.automationEnabled || !state.policy.reschedulingEnabled ||
          !state.policy.staffWorkEnabled || state.policy.capabilities.reschedule !== "execute") return err({ kind: "invalidTransition" });
      if (interpretation.preparation.kind === "needsReview") {
        retireClassMovementAction(state, target);
        state.callerMessages.push("I cannot verify permission to continue this class move. The clinic needs to review it before any further change.");
      } else if (interpretation.preparation.kind === "verificationRequired") {
        state.callerMessages.push("Before the next class stage, verify your registered email again. If you receive a six-digit code, enter it on the keypad, then press pound. Star clears your entry. Please do not say the code aloud. Verification alone makes no attendance change.");
      } else {
        if (interpretation.preparation.expectedConversationRevision !== state.conversationRevision - 1) return err({ kind: "staleTurn" });
        const prepared = prepareClassMovementConsent(state, interpretation.actionKey, interpretation.preparation.evidence, now);
        if (!prepared.ok) return prepared;
      }
      break;
    }
    case "conversationControl":
      state.callerMessages.push(conversationControlText[interpretation.notice]);
      break;
    case "missedCallReasonUnavailable":
      if (turn.quality !== "clear") return err({ kind: "invalidTransition" });
      state.callerMessages.push(missedCallText);
      break;
    case "conversationPresence":
      if (turn.quality !== "clear") return err({ kind: "invalidTransition" });
      state.callerMessages.push(conversationPresenceText);
      break;
    case "bookingHorizon":
      state.callerMessages.push(bookingHorizonText(state, validBookingHorizon(interpretation.snapshot, state, turn.sessionId!, now) ? interpretation.snapshot : undefined));
      break;
    case "bookingHorizonFailure":
      state.callerMessages.push(bookingHorizonText(state));
      break;
    case "requestBoundary":
      state.lastRequestBoundary = { turnId: turn.turnId, reason: interpretation.reason };
      state.callerMessages.push(requestBoundaryText(state, interpretation.reason));
      break;
    case "callerIdentityDenied":
      state.callerIdentityDenied ??= interpretation.reason;
      for (const action of Object.values(state.actions)) {
        if (action.classMovement?.outcome === "pending") retireClassMovementAction(state, action);
      }
      state.callerMessages.push(callerIdentityDenialText);
      break;
    case "staffOutcomeQuery":
      state.callerMessages.push(staffOutcomeText(state, undefined, interpretation.reviewProcess, now));
      break;
    case "staffUnavailable":
      if (interpretation.requestSubject !== undefined && !validStaffRequestSubject(interpretation.requestSubject)) return err({ kind: "invalidTransition" });
      state.callerMessages.push(interpretation.requestSubject ?
        (Object.values(state.staffItems).some(item => item.reason === "callerRequested") ? staffOutcomeText(state) + " " : "") + staffSubjectUnavailable(interpretation.requestSubject) : staffUnavailableText);
      break;
    case "staffMessageNotice":
      if (!validStaffMessageNotice(interpretation.notice)) return err({ kind: "invalidTransition" });
      state.callerMessages.push((interpretation.notice === "alreadySent" ? staffOutcomeText(state) + " " : "") + staffMessageNoticeText[interpretation.notice]);
      break;
    case "staffRequestReady":
      if (state.policy.staffWorkEnabled === false || interpretation.requestedPerson !== undefined && !validStaffLabel(interpretation.requestedPerson) ||
          interpretation.requestSubject !== undefined && !validStaffRequestSubject(interpretation.requestSubject)) return err({ kind: "invalidTransition" });
      addStaffTask(state, "callerRequested", now, undefined, undefined, interpretation.requestedPerson, interpretation.requestSubject);
      break;
    case "staffVerificationRequired":
      if (interpretation.requestSubject !== undefined && !validStaffRequestSubject(interpretation.requestSubject)) return err({ kind: "invalidTransition" });
      state.callerMessages.push((interpretation.requestSubject ? `You are asking staff about ${staffRequestSubjectLabel[interpretation.requestSubject]}. ${staffRequestSubjectLimit[interpretation.requestSubject]} ` : "") +
        "Before saving a staff request, verify your registered email. If you receive a six-digit code, enter it on the keypad, then press pound. Star clears your entry. Please do not say the code aloud. " + (interpretation.messageDraft === true ? "After verification, tell me your message. You can add or correct details before asking me to send it." : "After verification, ask me to send the request."));
      break;
    case "workflowStarted": {
      if (!["book", "cancel", "reschedule", "intake", "patientUpdate", "confirmationResend", "appointments.read"].includes(interpretation.operation) ||
          (interpretation.operation === "intake" ? interpretation.next !== "intakeRequired" : interpretation.next !== "codeRequired" &&
            (interpretation.next !== "representativeRequired" || !["book", "cancel", "reschedule", "appointments.read"].includes(interpretation.operation))) ||
          (interpretation.operation !== "appointments.read" && state.policy.capabilities[interpretation.operation] !== "execute") || !state.policy.automationEnabled) return err({ kind: "invalidTransition" });
      if (interpretation.advanceTask) state.previousTaskActionKeys = Object.keys(state.actions);
      state.lastWorkflowStart = { turnId: turn.turnId, operation: interpretation.operation, next: interpretation.next };
      state.callerMessages.push(interpretation.next === "representativeRequired"
        ? "We need to verify you as the caller, then privately collect and verify the patient's details. Press one to begin, or star to stop."
        : interpretation.next === "codeRequired"
        ? "Before we continue, verify your email. If you receive a six-digit code, enter it on the keypad, then press pound. Star clears your entry. Please do not say the code aloud."
        : "Before registration, we will explain privacy and what happens if the call fails, then review your details. Registration does not book an appointment. Press one to start private registration, or star to stop.");
      break;
    }
    case "outcomeQuery": {
      const current = Object.values(state.actions).filter(action => !state.previousTaskActionKeys?.includes(action.key)).at(-1);
      state.callerMessages.push(!current && state.previousTaskActionKeys?.length ? "I haven't completed an action for this new task." : actionOutcomeText(current));
      break;
    }
    case "notificationOutcomeQuery":
      state.callerMessages.push(notificationOutcomeText(state));
      break;
    case "modelPending": {
      if (!state.policy.automationEnabled || turn.quality !== "clear" || turn.turnId.length > 256 ||
          !/^[a-f0-9]{64}$/.test(interpretation.taskRef)) return err({ kind: "invalidTransition" });
      const id = `model:${interpretation.taskRef}`;
      state.effects[id] = { kind: "model", schemaVersion: 1, id, taskRef: interpretation.taskRef, turnId: turn.turnId,
        conversationRevision: state.conversationRevision, status: "pending" };
      break;
    }
    case "previousPractitioner":
      state.callerMessages.push(previousPractitionerText(interpretation.snapshot, state, now) ?? previousPractitionerUnavailable);
      break;
    case "previousPractitionerUnavailable":
      state.callerMessages.push(previousPractitionerUnavailable);
      break;
    case "classServiceQuestion": {
      const text = classServiceQuestionText(interpretation.question, now), operation = interpretation.question?.operation;
      if (!text || turn.quality !== "clear" || !state.policy.automationEnabled || !state.policy.staffWorkEnabled ||
          state.policy.capabilities[operation] !== "execute" || !(operation === "book" ? state.policy.bookingEnabled : operation === "cancel" ? state.policy.cancellationEnabled : state.policy.reschedulingEnabled)) return err({ kind: "invalidTransition" });
      state.callerMessages.push(text);
      break;
    }
    case "serviceQuestion": {
      const text = bookingServiceQuestionText(interpretation.question);
      if (!text || turn.quality !== "clear" || !state.policy.automationEnabled || state.policy.capabilities.book !== "execute") return err({ kind: "invalidTransition" });
      state.callerMessages.push(text);
      break;
    }
    case "clarify":
      state.callerMessages.push(clarificationText(interpretation.reason, Object.values(state.actions).at(-1), interpretation.approvedLocation));
      break;
    case "modelFallback":
      if (interpretation.staffWorkUnavailable !== true) addStaffTask(state, "systemFailure", now);
      state.callerMessages.push(interpretation.staffWorkUnavailable === true
        ? "I couldn't understand that safely. Could you repeat your request, or contact the clinic directly?"
        : staffRequestNotice(state));
      break;
    case "requestAction": {
      const result = handleRequest(state, turn, interpretation.request, now);
      if (!result.ok) return result;
      break;
    }
    case "confirmationWait": {
      const action = state.actions[interpretation.actionKey];
      const permitted = action?.kind === "book" ? state.policy.bookingEnabled && state.policy.capabilities.book === "execute" :
        action?.kind === "reschedule" ? state.policy.reschedulingEnabled && state.policy.capabilities.reschedule === "execute" :
          action?.kind === "cancel" ? state.policy.cancellationEnabled && state.policy.capabilities.cancel === "execute" : false;
      if (turn.quality !== "clear" || !clearAffirmation(turn.text) || !action || action.status !== "awaitingConfirmation" || action.classMovement ||
          !permitted || !state.policy.automationEnabled || !state.policy.staffWorkEnabled ||
          action.digest !== interpretation.digest || state.pendingPresentationId || state.presentations[action.presentationId]?.status !== "played" ||
          !Number.isSafeInteger(interpretation.seconds) || interpretation.seconds < 1 || interpretation.seconds > 60 ||
          evidenceFailure(state, action.mutation.request, now) ||
          Object.values(state.actions).some(other => other.key !== action.key && ["awaitingConfirmation", "ready"].includes(other.status))) return err({ kind: "confirmationMissing" });
      state.callerMessages.push(action.kind === "book"
        ? `The booking system needs a moment. Please wait about ${interpretation.seconds} seconds, then say yes again if you still want this booking. I haven't booked an appointment, and this time is not reserved.`
        : action.kind === "cancel" ? `The booking system needs a moment. Please wait about ${interpretation.seconds} seconds, then say yes again if you still want this cancellation. I haven't cancelled your attendance.`
        : `The booking system needs a moment. Please wait about ${interpretation.seconds} seconds, then say yes again if you still want this change. I haven't changed your appointment, and the replacement time is not reserved.`);
      break;
    }
    case "classMovementAffirm": {
      const action = state.actions[interpretation.actionKey], consent = action?.classMovementConsent;
      if (turn.quality !== "clear" || !clearAffirmation(turn.text) || !action || action.status !== "awaitingConfirmation" || !consent ||
          interpretation.digest !== consent.digest || state.pendingPresentationId ||
          state.presentations[consent.presentationId]?.status !== "played" || !consent.playedAt ||
          Date.parse(turn.at) < Date.parse(consent.playedAt) || Date.parse(turn.at) > Date.parse(now)) return err({ kind: "confirmationMissing" });
      const current = readClassMovementConsent(state, action, consent.evidence, now);
      if (!current || current.digest !== consent.digest) return err({ kind: "confirmationMissing" });
      const id = `${action.key}:classStage:${consent.digest}`;
      if (state.effects[id]) return err({ kind: "invalidTransition" });
      state.actions[action.key] = { ...action, status: "ready" };
      state.effects[id] = { kind: "hostWrite", id, actionKey: action.key, mutation: action.mutation,
        classMovementConsent: current, status: "pending" };
      break;
    }
    case "affirm": {
      const action = state.actions[interpretation.actionKey];
      if (!interpretation.affirmative || turn.quality !== "clear" || !action || action.status !== "awaitingConfirmation" || action.classMovement) {
        return err({ kind: "confirmationMissing" });
      }
      if (interpretation.digest !== action.digest) return err({ kind: "digestChanged" });
      if (state.presentations[action.presentationId]?.status !== "played") return err({ kind: "confirmationMissing" });
      const evidence = evidenceFailure(state, action.mutation.request, now);
      if (evidence) {
        if (action.kind !== "cancel" && action.kind !== "reschedule") return err(evidence);
        state.actions[action.key] = { ...action, status: "canceled" };
        state.callerMessages.push("I can't verify the appointment and fee details now. No change was made. Please contact the clinic.");
        break;
      }
      state.actions[action.key] = { ...action, status: "ready" };
      state.effects[`${action.key}:write`] = { kind: "hostWrite", id: `${action.key}:write`, actionKey: action.key, mutation: action.mutation, status: "pending" };
      break;
    }
    case "handoff":
      if (interpretation.requestedPerson !== undefined && !validStaffLabel(interpretation.requestedPerson)) return err({ kind: "invalidTransition" });
      if (interpretation.staffWorkUnavailable !== true) addStaffTask(state, interpretation.reason, now, undefined, undefined, interpretation.requestedPerson);
      state.callerMessages.push(interpretation.reason === "potentiallyUrgent"
        ? urgentHandoffNotice(state, now, interpretation.staffWorkUnavailable === true) : staffRequestNotice(state, interpretation.staffWorkUnavailable === true));
      break;
    case "transfer": {
      if (interpretation.reason === "potentiallyUrgent") {
        addStaffTask(state, interpretation.reason, now);
        state.callerMessages.push(urgentHandoffNotice(state, now));
      } else if (turn.quality !== "clear") {
        addStaffTask(state, "verificationFailed", now);
        state.callerMessages.push(staffFallbackText(state, "I can't confirm the transfer request safely. I'll request staff follow-up."));
      } else if (state.policy.capabilities.transfer === "execute" && state.policy.transferDestinationRef?.trim() && staffedForTransfer(state.policy, now)) {
        const id = createHash("sha256").update(JSON.stringify([state.callId, turn.turnId, state.policy.transferDestinationRef])).digest("hex");
        state.presentations[id] = { kind: "transfer", id, destinationRef: state.policy.transferDestinationRef, reason: interpretation.reason, status: "pending" };
        state.pendingPresentationId = id;
      } else if (state.policy.capabilities.transfer === "execute" && state.policy.transferDestinationRef?.trim()) {
        addStaffTask(state, interpretation.reason, now);
        state.callerMessages.push(transferUnavailableNotice(state, now));
      } else if (state.policy.capabilities.transfer === "requestOnly") {
        addStaffTask(state, interpretation.reason, now);
        state.callerMessages.push(staffFallbackText(state, "I can request staff follow-up, but I can't confirm they've received it yet."));
      } else {
        state.callerMessages.push("I can't connect you to staff from this call.");
      }
      break;
    }
    case "ambiguousTarget":
      addStaffTask(state, "verificationFailed", now);
      state.callerMessages.push(staffFallbackText(state, "I can't identify the right appointment safely. I'll request staff follow-up."));
      break;
    case "readFailure":
      if (interpretation.failure === "notFound") {
        state.callerMessages.push(interpretation.target === "patient" ? "I couldn't find a matching patient."
          : interpretation.target === "appointment" ? "I couldn't identify that appointment safely."
            : "I couldn't find an eligible time.");
      } else {
        addStaffTask(state, "systemFailure", now);
        state.callerMessages.push(interpretation.target === "patient" ? "I can't check patient records right now."
          : interpretation.target === "appointment" ? "I can't check that appointment right now."
            : "I can't check available times right now.");
      }
      break;
    case "intakeFailure":
      state.callerMessages.push(interpretation.reason === "missing"
        ? "I can't verify approved intake details for this call."
        : "I can't check approved intake details right now.");
      break;
    case "unavailableAction":
      state.callerMessages.push("I can't complete that request here.");
      break;
    case "answer": {
      const sources = Array.isArray(interpretation.sources) ? interpretation.sources : [];
      const source = sources[0];
      if (turn.quality !== "clear" || sources.length !== 1 ||
          !validCallKnowledgeSource(source, state.policy, now) || interpretation.proposedText !== source.approvedText ||
          interpretation.publicTopic !== undefined && source.sourceRef !== `clinic-public-${interpretation.publicTopic}`) {
        if (!interpretation.publicTopic) addStaffTask(state, "systemFailure", now);
        state.callerMessages.push(interpretation.publicTopic ? publicInformationUnavailable(interpretation.publicTopic) : "I can't verify that information right now.");
      } else {
        state.callerMessages.push(source.approvedText);
        state.knowledgeAnswers.push({ turnId: turn.turnId, sourceRef: source.sourceRef, version: source.version, ownerRef: source.ownerRef });
      }
      break;
    }
    case "knowledgeFailure":
      if (!interpretation.publicTopic) addStaffTask(state, "systemFailure", now);
      state.callerMessages.push(interpretation.publicTopic ? publicInformationUnavailable(interpretation.publicTopic) : "I can't verify that information right now.");
      break;
    case "availability": {
      const presentation = availabilityPresentation(interpretation.snapshot, state.policy.scope, interpretation.from, interpretation.to,
        now, !state.callerIdentityDenied && state.policy.staffWorkEnabled !== false, state.policy.voiceProfile?.locale ?? "en-AU");
      if (turn.quality !== "clear" || !presentation.ok) {
        addStaffTask(state, "systemFailure", now);
        state.callerMessages.push(staffFallbackText(state, "I can't check available times right now. I'll request staff follow-up."));
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
      state.callerMessages.push(staffFallbackText(state, "I can't check available times right now. I'll request staff follow-up."));
      state.availabilityReads.push({ turnId: turn.turnId, status: "failed", reason: interpretation.reason });
      break;
    case "reschedulingMenu": {
      const menu = reschedulingMenuPresentation(interpretation.snapshot, { scope: state.policy.scope, callId: state.callId,
        sessionId: turn.sessionId ?? "", policyVersion: state.policy.policyVersion }, now, state.policy.voiceProfile?.locale ?? "en-AU");
      state.callerMessages.push(turn.quality === "clear" && menu.ok ? menu.value : "I can't check rescheduling options right now. Please contact the clinic directly.");
      break;
    }
    case "reschedulingMenuFailure":
      state.callerMessages.push("I can't check or select those rescheduling options right now. Please request fresh options or contact the clinic directly.");
      break;
    case "bookingMenu": {
      const menu = bookingMenuPresentation(interpretation.snapshot, { scope: state.policy.scope, callId: state.callId,
        sessionId: turn.sessionId ?? "", policyVersion: state.policy.policyVersion }, now, state.policy.voiceProfile?.locale ?? "en-AU");
      state.callerMessages.push(turn.quality === "clear" && menu.ok ? menu.value : "I can't check booking options right now. Please contact the clinic directly.");
      break;
    }
    case "bookingMenuFailure":
      state.callerMessages.push("I can't check or select those booking options right now. Please request fresh options or contact the clinic directly.");
      break;
    case "appointments": {
      const presentation = appointmentPresentation(interpretation.snapshot, state.policy.scope, interpretation.from, interpretation.to, now, state.policy.voiceProfile?.locale ?? "en-AU", interpretation.declareRange === true);
      if (turn.quality !== "clear" || !presentation.ok) {
        addStaffTask(state, "systemFailure", now);
        state.callerMessages.push(staffFallbackText(state, "I can't check appointments right now. I'll request staff follow-up."));
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
      state.callerMessages.push(staffFallbackText(state, interpretation.reason === "invalidProof" || interpretation.reason === "unclear"
        ? "I can't verify whose appointment to check. I'll request staff follow-up."
        : "I can't check appointments right now. I'll request staff follow-up."));
      state.appointmentReads.push({ turnId: turn.turnId, status: "failed", reason: interpretation.reason });
      break;
  }
  const newMessages = state.callerMessages.slice(messageCount);
  if (newMessages.length > 0 && !state.pendingPresentationId) {
    const id = noticePresentationId(state.callId, turn.turnId);
    state.presentations[id] = { kind: "notice", id, approvedText: newMessages.join(" "), status: "pending",
      ...(interpretation.kind === "confirmationWait" ? { confirmationWaitSeconds: interpretation.seconds } : {}) };
    state.pendingPresentationId = id;
  }
  state.processedTurnIds.push(turn.turnId);
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
  if (action.classMovement?.outcome === "moved" || action.classMovement?.outcome === "restored") {
    state.effects[effectId] = { ...effect, status: "completed" };
    return ok(undefined);
  }

  if (receipt.kind === "classMovement") {
    if (action.kind !== "reschedule" || effect.mutation.kind !== "reschedule" || effect.mutation.notification) return err({ kind: "invalidTransition" });
    const record = readClassMovementReceipt(receipt, action.classMovement, state.lifecycle === "active" && !state.callerIdentityDenied);
    if (!record) return err({ kind: "invalidTransition" });
    const status = record.movement.outcome === "moved" ? "committed" : record.movement.outcome === "restored" ? "rejected"
      : record.movement.outcome === "pending" ? "pendingContinuation" : "needsReview";
    const { classMovementConsent: _consumedConsent, ...remaining } = action;
    state.actions[action.key] = { ...remaining, status, classMovement: record.movement, ...(record.hostRef ? { hostRef: record.hostRef } : {}) };
    state.effects[effectId] = { ...effect, status: "completed" };
    hostOutcomeNotice(state, effectId, classMovementOutcomeText(record.movement));
    return ok(undefined);
  }

  // A normal acknowledgement describes one effect, not the joint attendance
  // and membership result. It cannot promote a partial move to completion or
  // erase the earlier native changes after a later rejection.
  if (action.classMovement && receipt.kind !== "uncertain") {
    const movement = receipt.kind === "committed" ? uncertainClassMovement(action.classMovement) : stopClassMovement(action.classMovement);
    const { classMovementConsent: _consumedConsent, ...remaining } = action;
    state.actions[action.key] = { ...remaining, status: "needsReview", classMovement: movement };
    state.effects[effectId] = { ...effect, status: "completed" };
    hostOutcomeNotice(state, effectId, classMovementOutcomeText(movement));
    return ok(undefined);
  }

  if (receipt.kind === "committed") {
    if (!receipt.hostRef) return err({ kind: "invalidTransition" });
    state.actions[action.key] = { ...action, status: "committed", hostRef: receipt.hostRef };
    state.effects[effectId] = { ...effect, status: "completed" };
    queueCommittedNotification(state, action, receipt.hostRef, receipt.notification);
    hostOutcomeNotice(state, effectId, confirmedActionText(action.kind));
  } else if (receipt.kind === "uncertain") {
    if (!Number.isFinite(Date.parse(receipt.reconcileAfter)) || !Number.isFinite(Date.parse(receipt.deadline)) || Date.parse(receipt.deadline) <= Date.parse(now)) return err({ kind: "invalidTransition" });
    const { classMovementConsent: _consumedConsent, ...remaining } = action;
    state.actions[action.key] = { ...remaining, status: "uncertain", reconciliationDeadline: receipt.deadline,
      ...(action.classMovement ? { classMovement: uncertainClassMovement(action.classMovement) } : {}) };
    state.effects[effectId] = { ...effect, status: "uncertain" };
    const reconcileId = `${effectId}:reconcile`;
    state.effects[reconcileId] = { kind: "hostReconcile", id: reconcileId, actionKey: action.key, originalEffectId: effectId, status: "pending" };
    hostOutcomeNotice(state, effectId, actionOutcomeText(state.actions[action.key]));
    if (action.kind === "book" && Object.values(state.actions).some(item => item.kind === "intake" && item.status === "committed")) {
      addStaffTask(state, "partialIntake", now, action.key);
    }
  } else {
    state.actions[action.key] = { ...action, status: receipt.kind === "unsupported" ? "unsupported" : "rejected" };
    state.effects[effectId] = { ...effect, status: "completed" };
    hostOutcomeNotice(state, effectId, "That action was not completed.");
    if (action.kind === "book" && Object.values(state.actions).some(item => item.kind === "intake" && item.status === "committed")) {
      addStaffTask(state, "partialIntake", now, action.key);
    }
  }
  return ok(undefined);
}

export function transition(current: CallState, action: TransitionAction): Result<CallState, TransitionFailure> {
  if ("now" in action && action.now !== undefined && !Number.isFinite(Date.parse(action.now))) return err({ kind: "invalidTransition" });
  if (current.callerIdentityDenied && ["markHostPossiblySent", "markStaffPossiblySent", "markStaffChangePossiblySent",
    "markNotificationPossiblySent", "markOperatorAlertPossiblySent", "transferPossiblySent", "privateIntakePrompt", "privateCorrectionPrompt", "privateResendPrompt", "privateRepresentativePrompt"].includes(action.kind))
    return err({ kind: "invalidTransition" });
  const state = structuredClone(current);
  const now = "now" in action && action.now !== undefined ? action.now : new Date(0).toISOString();

  switch (action.kind) {
    case "markNotificationPossiblySent":
    case "recoverNotificationPossiblySent":
    case "notificationBlocked":
    case "notificationResolved":
    case "notificationReconciled": {
      const result = transitionNotification(state, action);
      if (!result.ok) return result;
      break;
    }
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
    case "textPresentationWritten": {
      const presentation = state.presentations[action.presentationId];
      if (state.lifecycle === "ended" && state.terminal?.reason === "textCompleted" &&
          presentation?.kind === "notice" && presentation.status === "played" &&
          Object.values(state.presentations).filter(item => item.status === "played").length === 1) return ok(current);
      if (state.lifecycle !== "active" || state.admission || state.sessionLease ||
          state.pendingPresentationId !== action.presentationId || presentation?.kind !== "notice" ||
          presentation.status !== "pending" ||
          Object.values(state.presentations).some(item => item.id !== action.presentationId &&
            (item.status === "pending" || item.status === "started" || item.status === "possiblySent" || item.status === "played"))) {
        return err({ kind: "invalidTransition" });
      }
      state.presentations[action.presentationId] = { ...presentation, status: "played" };
      delete state.pendingPresentationId;
      endMedia(state, now, "textCompleted");
      break;
    }
    case "nonAffirmativeFinal": {
      const turn = action.turn, lease = state.sessionLease;
      if (state.lifecycle !== "active" || !state.admission || !lease || lease.sessionId !== turn.sessionId ||
          turn.callId !== state.callId || !turn.turnId || !Number.isFinite(Date.parse(turn.at)) ||
          state.processedTurnIds.includes(turn.turnId) || turn.quality !== "clear" || !turn.text.trim() || clearAffirmation(turn.text) ||
          Date.parse(action.now) >= Date.parse(lease.expiresAt)) return err({ kind: "invalidTransition" });
      if (state.conversationRevision !== action.expectedConversationRevision) return err({ kind: "staleTurn" });
      supersedeUnsent(state);
      state.conversationRevision += 1;
      cancelModelWork(state);
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
        if (candidate.classMovement && (candidate.status === "ready" || candidate.status === "dispatched")) {
          retireClassMovementAction(state, candidate); continue;
        }
        const presentation = state.presentations[candidate.presentationId];
        if (candidate.status === "awaitingConfirmation" && presentation && (presentation.status === "started" || presentation.status === "superseded")) {
          if (candidate.classMovement) retireClassMovementAction(state, candidate);
          else state.actions[key] = { ...candidate, status: "canceled" };
        }
      }
      state.conversationRevision += 1;
      cancelModelWork(state);
      break;
    }
    case "privateRepresentativePrompt": {
      const lease = state.sessionLease;
      if (state.lifecycle !== "active" || !state.admission || !lease || lease.sessionId !== action.sessionId ||
          Date.parse(action.now) >= Date.parse(lease.expiresAt) || !state.policy.automationEnabled ||
          !["book", "cancel", "reschedule", "appointments.read"].includes(action.operation) ||
          action.operation !== "appointments.read" && state.policy.capabilities[action.operation] !== "execute") return err({ kind: "leaseLost" });
      if (!/^[a-f0-9-]{36}$/.test(action.presentationId) || state.pendingPresentationId || state.presentations[action.presentationId] ||
          Object.values(state.presentations).some(item => item.status === "started" || item.status === "possiblySent") ||
          Object.values(state.actions).some(item => !state.previousTaskActionKeys?.includes(item.key) && item.status !== "canceled")) return err({ kind: "invalidTransition" });
      state.presentations[action.presentationId] = { kind: "notice", id: action.presentationId, approvedText: "", status: "pending" };
      state.pendingPresentationId = action.presentationId;
      break;
    }
    case "privateIntakePrompt":
    case "privateCorrectionPrompt":
    case "privateResendPrompt": {
      const lease = state.sessionLease;
      if (state.lifecycle !== "active" || !state.admission || !lease || lease.sessionId !== action.sessionId ||
          Date.parse(action.now) >= Date.parse(lease.expiresAt) || !state.policy.automationEnabled ||
          (action.kind === "privateIntakePrompt"
            ? state.policy.capabilities.intake !== "execute" || state.policy.firstTimeIntakeEnabled !== true
            : action.kind === "privateCorrectionPrompt" ? state.policy.capabilities.patientUpdate !== "execute" || state.policy.patientCorrectionsEnabled !== true
              : state.policy.capabilities.confirmationResend !== "execute" || !/^[a-f0-9]{64}$/.test(state.policy.confirmationResendVersion ?? ""))) return err({ kind: "leaseLost" });
      if (!/^[a-f0-9-]{36}$/.test(action.presentationId) || state.pendingPresentationId || state.presentations[action.presentationId] ||
          Object.values(state.presentations).some(item => item.status === "started" || item.status === "possiblySent")) return err({ kind: "invalidTransition" });
      if (action.kind === "privateCorrectionPrompt" || action.kind === "privateResendPrompt") {
        // Re-entering private fields withdraws the old correction confirmation.
        // A dispatched/possibly-sent correction cannot be edited or retried.
        const corrections = Object.values(state.actions).filter(item => item.kind === (action.kind === "privateCorrectionPrompt" ? "patientUpdate" : "confirmationResend"));
        if (corrections.some(item => ["dispatched", "committed", "uncertain", "needsReview"].includes(item.status) ||
            state.effects[`${item.key}:write`]?.status === "possiblySent")) return err({ kind: "invalidTransition" });
        for (const item of corrections) {
          if (item.status !== "awaitingConfirmation" && item.status !== "ready") continue;
          state.actions[item.key] = { ...item, status: "canceled" };
          const effect = state.effects[`${item.key}:write`];
          if (effect?.kind === "hostWrite" && effect.status === "pending") state.effects[effect.id] = { ...effect, status: "canceled" };
        }
      }
      state.presentations[action.presentationId] = { kind: "notice", id: action.presentationId, approvedText: "", status: "pending" };
      state.pendingPresentationId = action.presentationId;
      break;
    }
    case "silenceTimeout": {
      const lease = state.sessionLease;
      if (state.lifecycle !== "active" || !state.admission || !lease || lease.sessionId !== action.sessionId ||
          Date.parse(action.now) >= Date.parse(lease.expiresAt)) return err({ kind: "leaseLost" });
      if (action.stage !== "retry" && action.stage !== "final") return err({ kind: "invalidTransition" });
      if (state.pendingPresentationId || Object.values(state.presentations).some(presentation =>
        presentation.status === "started" || presentation.status === "possiblySent")) return err({ kind: "invalidTransition" });
      const noticeId = (stage: "retry" | "final") => createHash("sha256").update(JSON.stringify([
        state.callId, action.sessionId, state.conversationRevision, stage, "silence",
      ])).digest("hex");
      if (action.stage === "final" && state.presentations[noticeId("retry")]?.status !== "played") {
        return err({ kind: "invalidTransition" });
      }
      const id = noticeId(action.stage);
      if (state.presentations[id]) return err({ kind: "invalidTransition" });
      const approvedText = action.stage === "retry" ? SILENCE_RETRY_NOTICE : SILENCE_FINAL_NOTICE;
      state.presentations[id] = { kind: "notice", id, approvedText, status: "pending" };
      state.pendingPresentationId = id;
      state.callerMessages.push(approvedText);
      break;
    }
    case "callerTurn": {
      if (current.processedTurnIds.includes(action.turn.turnId)) {
        return ok(current);
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
        const approvedText = transferUnavailableNotice(state, now);
        state.presentations[noticeId] = { kind: "notice", id: noticeId, approvedText, status: "pending" };
        state.pendingPresentationId = noticeId;
        state.callerMessages.push(approvedText);
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
            const approvedText = staffFallbackText(state, "I couldn't connect you. I'll request staff follow-up, but I can't confirm they've received it yet.");
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
        if (presentation.kind === "speech") {
          const linked = state.actions[presentation.actionKey], consent = linked?.classMovementConsent;
          if (linked && consent?.presentationId === presentation.id) {
            if (action.status === "played" && action.now)
              state.actions[linked.key] = { ...linked, classMovementConsent: { ...consent, playedAt: action.now } };
            else retireClassMovementAction(state, linked);
          }
        }
      }
      break;
    }
    case "classMovementConsentPrepared": {
      if (!Number.isSafeInteger(action.expectedConversationRevision) || state.conversationRevision !== action.expectedConversationRevision)
        return err({ kind: "staleTurn" });
      const prepared = prepareClassMovementConsent(state, action.actionKey, action.evidence, now);
      if (!prepared.ok) return prepared;
      break;
    }
    case "markHostPossiblySent": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "hostWrite") return err({ kind: "effectUnknown" });
      const pendingAction = state.actions[effect.actionKey];
      if (effect.status !== "pending" || pendingAction?.status !== "ready" || pendingAction.digest !== effect.mutation.payloadDigest) return err({ kind: "invalidTransition" });
      if (effect.classMovementConsent) {
        const current = readClassMovementConsent(state, pendingAction, effect.classMovementConsent.evidence, now);
        const consent = pendingAction.classMovementConsent;
        if (!current || current.digest !== effect.classMovementConsent.digest || consent?.digest !== current.digest ||
            state.presentations[consent.presentationId]?.status !== "played" || !consent.playedAt) return err({ kind: "confirmationMissing" });
      } else {
        if (pendingAction.classMovement) return err({ kind: "confirmationMissing" });
        const evidence = evidenceFailure(state, effect.mutation.request, now);
        if (evidence) return err(evidence);
      }
      state.effects[effect.id] = { ...effect, status: "possiblySent", possiblySentAt: now };
      state.actions[pendingAction.key] = { ...state.actions[pendingAction.key]!, status: "dispatched" };
      break;
    }
    case "hostWriteBlocked": {
      const effect = state.effects[action.effectId];
      if (!effect || effect.kind !== "hostWrite") return err({ kind: "effectUnknown" });
      const pendingAction = state.actions[effect.actionKey];
      if (effect.status !== "pending" || pendingAction?.status !== "ready" || pendingAction.digest !== effect.mutation.payloadDigest) return err({ kind: "invalidTransition" });
      state.effects[effect.id] = { ...effect, status: "canceled" };
      const movement = pendingAction.classMovement ? stopClassMovement(pendingAction.classMovement) : undefined;
      const { classMovementConsent: _blockedConsent, ...remaining } = pendingAction;
      state.actions[pendingAction.key] = { ...remaining, status: movement ? "needsReview" : "unsupported",
        ...(movement ? { classMovement: movement } : {}) };
      if (action.reason !== undefined && action.reason !== "unsupported") return err({ kind: "invalidTransition" });
      addStaffTask(state, action.reason ?? "emergencyStopped", action.now, pendingAction.key, effect.mutation.request);
      const stoppedText = movement ? classMovementOutcomeText(movement) : "I can't complete that action now.";
      const approvedText = staffFallbackText(state, `${stoppedText} I'll request staff follow-up, but I can't confirm they've received it yet.`);
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
      if (linked.classMovement) {
        if (action.observation.kind === "stillUnknown" && linked.reconciliationDeadline && Date.parse(action.now) < Date.parse(linked.reconciliationDeadline)) return ok(current);
        const movement = stopClassMovement(linked.classMovement);
        state.actions[linked.key] = { ...linked, status: "needsReview", classMovement: movement };
        state.effects[effect.id] = { ...effect, status: "completed" };
        addStaffTask(state, "uncertainAction", action.now, linked.key);
        hostOutcomeNotice(state, effect.id, classMovementOutcomeText(movement));
        break;
      }
      if (action.observation.kind === "exactCommit") {
        if (!action.observation.hostRef) return err({ kind: "invalidTransition" });
        state.actions[linked.key] = { ...linked, status: "committed", hostRef: action.observation.hostRef };
        queueCommittedNotification(state, linked, action.observation.hostRef, action.observation.notification);
        hostOutcomeNotice(state, effect.id, confirmedActionText(linked.kind));
      } else if (action.observation.kind === "definitiveNonCommit") {
        state.actions[linked.key] = { ...linked, status: "rejected" };
        hostOutcomeNotice(state, effect.id, "That action was not completed.");
      } else {
        if (!linked.reconciliationDeadline || Date.parse(action.now) >= Date.parse(linked.reconciliationDeadline)) {
          state.actions[linked.key] = { ...linked, status: "needsReview" };
          if (linked.mutation.request.kind !== "intake" || linked.mutation.request.recoveryContract !== "callerMediated") {
            addStaffTask(state, "uncertainAction", action.now, linked.key);
          }
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
      if (!["opened", "uncertain", "rejected"].includes(action.receipt.kind)) return err({ kind: "invalidTransition" });
      if (action.receipt.kind === "opened" && typeof action.receipt.hostTaskRef === "string" && action.receipt.hostTaskRef.trim().length > 0 &&
          action.receipt.hostTaskRef.length <= 256 && !/[\u0000-\u001f\u007f]/.test(action.receipt.hostTaskRef) &&
          JSON.stringify(action.receipt.destination) === JSON.stringify(item.destination)) {
        state.staffItems[item.key] = { ...item, status: "open", hostTaskRef: action.receipt.hostTaskRef };
        state.effects[effect.id] = { ...effect, status: "completed" };
      } else {
        const uncertain = action.receipt.kind !== "rejected";
        if (uncertain) queueStaffReconciliation(state, effect.id, item);
        state.staffItems[item.key] = { ...item, status: "needsReview", destination: state.policy.operatorQueue };
        state.effects[effect.id] = { ...effect, status: uncertain ? "uncertain" : "completed" };
      }
      if (item.reason === "callerRequested" && !item.linkedActionKey) {
        hostOutcomeNotice(state, effect.id, staffOutcomeText(state, state.staffItems[item.key], action.receipt.kind === "opened" ? action.receipt.reviewProcess : undefined, action.now));
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
      if (linked.mutation.request.kind !== "intake" || linked.mutation.request.recoveryContract !== "callerMediated") {
        addStaffTask(state, "uncertainAction", action.now, linked.key);
      }
      break;
    }
  }
  redactSettledContent(state);
  state.version = current.version + 1;
  return ok(state);
}
