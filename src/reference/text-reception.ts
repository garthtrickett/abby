import { confirmationResendEvidenceFailure } from "../core/confirmation-resend.ts";
import { validStaffMessageNotice } from "../core/staff-message-notice.ts";
import { StaffOutcomeTurns } from "./staff-outcome-turns.ts";
import { ReschedulingMenuTurns } from "./rescheduling-menu-turns.ts";
import { AppointmentEnquiryTurns } from "./appointment-enquiry-turns.ts";
import { MissedCallTurns } from "./missed-call-turns.ts";
import { BookingMenuTurns } from "./booking-menu-turns.ts";
import { ClassMovementTurns } from "./class-movement-turns.ts";
import { EffectWorker } from "../core/effect-worker.ts";
import { EffectCallLeaseCoordinator } from "../core/effect-call-lease.ts";
import type { EffectCallLeaseStore } from "../core/effect-call-lease.ts";
import type { WorkflowHost, AppointmentChangeEvidenceHost, AppointmentChangeEvidenceQuery, AppointmentChangeSelection, AppointmentHost, AvailabilityHost, ReschedulingMenuHost, BookingMenuHost, BookingEvidenceHost, HostEffects, IntakeEvidenceHost, KnowledgeHost, ModelKnowledgeContextHost, NotificationHost, OperatorAlertHost, PolicyFailure, PolicyStore, StaffLifecycleHost } from "../core/host.ts";
import { captureKnowledgeSnapshot, validCallKnowledgeSource, validKnowledgeSource } from "../core/knowledge-evidence.ts";
import type { LedgerStore } from "../core/ledger.ts";
import { BookingHorizonTurns } from "./booking-horizon-turns.ts";
import { PublicInformationAnswers } from "./public-information-answers.ts";
import { publicInformationTopic } from "../core/public-information.ts";
import { validStaffRequestSubject } from "../core/staff-request-subject.ts";
import { validRequestBoundary } from "../core/request-boundary.ts";
import { validCallerIdentityDenial } from "../core/caller-identity.ts";
import { err } from "../core/model.ts";
import type { CallState, FinalCallerTurn, LocationScope, Result, StaffChangeRequest, TransitionFailure, TurnInterpretation } from "../core/model.ts";
import { CallRuntime } from "../core/runtime.ts";
import { appointmentChangeEvidenceFailure, noticePresentationId } from "../core/transition.ts";
import { modelTaskRef } from "../model/work.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { patientCorrectionEvidenceFailure } from "../core/patient-correction.ts";
import type { ModelWork } from "../model/work.ts";

export type TextHost = BookingEvidenceHost & HostEffects & KnowledgeHost & Partial<import("../core/host.ts").MissedCallContextHost & import("../core/host.ts").ClassMovementContinuationHost & import("../core/host.ts").StaffReviewProcessHost & import("../core/host.ts").BookingHorizonHost & import("../core/host.ts").RequestBoundaryHost & import("../core/host.ts").CallerIdentityHost & import("../core/host.ts").PreviousPractitionerHost & import("../core/host.ts").AppointmentEnquiryHost & import("../core/host.ts").StaffRequestHost & WorkflowHost & ReschedulingMenuHost & BookingMenuHost & ModelKnowledgeContextHost & StaffLifecycleHost & OperatorAlertHost & IntakeEvidenceHost & AppointmentChangeEvidenceHost & NotificationHost & import("../core/host.ts").PatientCorrectionEvidenceHost & import("../core/host.ts").ConfirmationResendEvidenceHost>;
export type TextReceptionFailure = TransitionFailure | PolicyFailure | Readonly<{ kind: "effectFailure" }>;

export const appointmentProposalEvidenceDeadlineMs = 15_000;

function validIntakeRef(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 256;
}

export class TextReception {
  private readonly ledger: LedgerStore;
  private readonly policy: PolicyStore;
  private readonly host: TextHost;
  private readonly knowledge: KnowledgeHost & Partial<ModelKnowledgeContextHost>;
  private readonly pinKnowledge: boolean;
  private readonly availability: AvailabilityHost | undefined;
  private readonly appointments: AppointmentHost | undefined;
  private readonly model: ModelWork | undefined;
  private readonly effectLeases: EffectCallLeaseCoordinator;
  private readonly clock: () => string;

  constructor(ledger: LedgerStore & EffectCallLeaseStore, policy: PolicyStore, host: TextHost, availability?: AvailabilityHost, appointments?: AppointmentHost, model?: ModelWork,
              knowledge?: KnowledgeHost & Partial<ModelKnowledgeContextHost>, clock: () => string = () => new Date().toISOString()) {
    this.ledger = ledger;
    this.effectLeases = new EffectCallLeaseCoordinator(ledger);
    this.policy = policy;
    this.host = host;
    this.knowledge = knowledge ?? host;
    this.pinKnowledge = knowledge !== undefined;
    this.availability = availability;
    this.appointments = appointments;
    this.model = model;
    this.clock = clock;
  }

  /** A public urgent cue cannot treat an ordinary task queue as a proven urgent route. */
  async respondUrgent(scope: LocationScope, turn: FinalCallerTurn) {
    // Public command timestamps cannot revive an expired admitted script.
    const now = this.currentInstant();
    if (!now) return err({ kind: "invalidTransition" as const });
    return this.runtime(scope).acceptTurn(turn, { kind: "handoff", reason: "potentiallyUrgent", staffWorkUnavailable: true }, now);
  }

  async notificationOutcome(scope: LocationScope, turn: FinalCallerTurn) {
    const now = this.currentInstant();
    if (!now) return err({ kind: "invalidTransition" as const });
    return this.runtime(scope).acceptTurn(turn, { kind: "notificationOutcomeQuery" }, now);
  }

  bookingHorizonEnabled(): boolean { return new BookingHorizonTurns(this.ledger, this.host, this.clock).enabled(); }
  async readBookingHorizon(scope: LocationScope, turn: FinalCallerTurn, expectedRevision?: number, external?: AbortSignal) {
    const denied = await this.patientAccessDenied(scope, turn, expectedRevision);
    if (denied) return denied;
    return new BookingHorizonTurns(this.ledger, this.host, this.clock).run(scope, turn, expectedRevision, external);
  }

  requestBoundaryEnabled(): boolean { return typeof this.host.clearUnsupportedWorkflow === "function"; }
  async respondRequestBoundary(scope: LocationScope, turn: FinalCallerTurn, reason: import("../core/request-boundary.ts").RequestBoundary,
    expectedRevision?: number) {
    const now = this.currentInstant();
    if (!this.requestBoundaryEnabled() || !now || !turn.sessionId || turn.quality !== "clear" || !validRequestBoundary(reason)) return err({ kind: "invalidTransition" as const });
    const state = await this.ledger.read(turn.callId, scope);
    if (!state.ok) return state;
    if (state.value.lifecycle !== "active" || state.value.sessionLease?.sessionId !== turn.sessionId ||
        Date.parse(state.value.sessionLease.expiresAt) <= Date.parse(now)) return err({ kind: "leaseLost" as const });
    if (state.value.callerIdentityDenied) return this.denyCallerIdentity(scope, turn, state.value.callerIdentityDenied, expectedRevision);
    const duplicate = state.value.processedTurnIds.includes(turn.turnId);
    if (duplicate && (state.value.lastRequestBoundary?.turnId !== turn.turnId || state.value.lastRequestBoundary.reason !== reason ||
        state.value.processedTurnIds.at(-1) !== turn.turnId)) return err({ kind: "keyMismatch" as const });
    // A recorded turn is not proof that private cleanup succeeded. Retry the
    // idempotent negative host operation while this is still the current turn.
    const accepted = duplicate ? state : await this.runtime(scope).acceptTurn(turn, { kind: "requestBoundary", reason }, now, expectedRevision);
    if (!accepted.ok) return accepted;
    this.cancelPendingModel(scope, turn.callId);
    let cleared = false;
    try { cleared = await this.host.clearUnsupportedWorkflow!({ scope, callId: turn.callId, sessionId: turn.sessionId,
      turnId: turn.turnId, conversationRevision: accepted.value.conversationRevision }); } catch { /* No positive authority is issued. */ }
    return cleared ? accepted : err({ kind: "effectFailure" as const });
  }

  callerIdentityEnabled(): boolean { return typeof this.host.revokeCallerPatientAccess === "function"; }

  async denyCallerIdentity(scope: LocationScope, turn: FinalCallerTurn, reason: import("../core/caller-identity.ts").CallerIdentityDenial,
    expectedConversationRevision?: number) {
    const now = this.currentInstant();
    if (!this.callerIdentityEnabled() || !now || !turn.sessionId || turn.quality !== "clear" || !validCallerIdentityDenial(reason)) return err({ kind: "invalidTransition" as const });
    const state = await this.ledger.read(turn.callId, scope);
    if (!state.ok) return state;
    if (state.value.lifecycle !== "active" || state.value.sessionLease?.sessionId !== turn.sessionId ||
        Date.parse(state.value.sessionLease.expiresAt) <= Date.parse(now)) return err({ kind: "leaseLost" as const });
    if (state.value.processedTurnIds.includes(turn.turnId) && !state.value.callerIdentityDenied) return err({ kind: "keyMismatch" as const });
    const accepted = await this.runtime(scope).acceptTurn(turn, { kind: "callerIdentityDenied", reason }, now, expectedConversationRevision);
    if (accepted.ok) {
      this.cancelPendingModel(scope, turn.callId);
      // SAM denies access first, so a rejected/late host release cannot restore caller authority.
      try { await this.host.revokeCallerPatientAccess?.({ scope, callId: turn.callId, sessionId: turn.sessionId,
        reason: accepted.value.callerIdentityDenied! }); }
      catch { /* The recorded denial still fences reception, interpretation and effects. */ }
    }
    return accepted;
  }

  private async patientAccessDenied(scope: LocationScope, turn: FinalCallerTurn, expectedRevision?: number) {
    const state = await this.ledger.read(turn.callId, scope);
    if (!state.ok) return state;
    if (!state.value.callerIdentityDenied) return undefined;
    return this.denyCallerIdentity(scope, turn, state.value.callerIdentityDenied, expectedRevision);
  }

  private currentInstant(): string | undefined {
    try { const now = this.clock(); return Number.isFinite(Date.parse(now)) ? now : undefined; }
    catch { return undefined; }
  }

  async startWorkflow(scope: LocationScope, turn: FinalCallerTurn, operation: import("../core/model.ts").WorkflowOperation, now: string,
    expectedConversationRevision?: number, external?: AbortSignal, replaceCanceledChange = false, serviceChoice?: import("../core/booking-service-choice.ts").BookingServiceChoice, forAnotherPerson?: true, classAttendance?: true, classSelectionRef?: string) {
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision);
    if (denied) return denied;
    const state = await this.ledger.read(turn.callId, scope);
    if (!state.ok) return state;
    if (!this.host.startWorkflow || !state.value.policy.policyVersion || !turn.sessionId || turn.quality !== "clear" || state.value.sessionLease?.sessionId !== turn.sessionId ||
        (expectedConversationRevision !== undefined && state.value.conversationRevision !== expectedConversationRevision)) return err({ kind: "invalidTransition" as const });
    if (state.value.processedTurnIds.includes(turn.turnId)) return state;
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    if (signal.aborted) return err({ kind: "staleTurn" as const });
    const query = { scope, callId: turn.callId, sessionId: turn.sessionId, policyVersion: state.value.policy.policyVersion,
      operation, signal, expectedConversationRevision: state.value.conversationRevision, turnId: turn.turnId,
      ...(serviceChoice ? { serviceChoice } : {}), ...(forAnotherPerson ? { forAnotherPerson } : {}), ...(classAttendance ? { classAttendance } : {}), ...(classSelectionRef ? { classSelectionRef } : {}), ...(replaceCanceledChange ? { replaceCanceledChange: true as const } : {}) };
    let selected, completed = false;
    try {
      try { selected = await awaitUntilAbort(this.host.startWorkflow(query), signal); } catch { selected = undefined; }
      if (external?.aborted) return err({ kind: "staleTurn" as const });
      const runtime = new CallRuntime(this.ledger, scope);
      const result = selected?.ok ? await runtime.acceptTurn(turn, { kind: "workflowStarted", operation, next: selected.value.kind,
        ...(selected.value.advanceTask ? { advanceTask: true as const } : {}) }, now, expectedConversationRevision)
        : await runtime.acceptTurn(turn, operation === "appointments.read" ? { kind: "appointmentsFailure", reason: "notConfigured" }
          : { kind: "unavailableAction", actionKind: operation }, now, expectedConversationRevision);
      if (!result.ok || !selected?.ok) return result;
      if (this.host.completeWorkflowStart && !await this.host.completeWorkflowStart({ ...query, ...(selected.value.advanceTask ? { advanceTask: true as const } : {}) })) return err({ kind: "staleTurn" as const });
      completed = true; return result;
    } catch { return err({ kind: "staleTurn" as const }); }
    finally { if (!completed) await this.host.abandonWorkflowStart?.(query); }
  }

  async readPreviousPractitioner(scope: LocationScope, turn: FinalCallerTurn, expectedRevision: number, external: AbortSignal) {
    const denied = await this.patientAccessDenied(scope, turn, expectedRevision); if (denied) return denied;
    const state = await this.ledger.read(turn.callId, scope); if (!state.ok) return state;
    const now = this.currentInstant();
    if (!now || turn.quality !== "clear" || !turn.sessionId || state.value.conversationRevision !== expectedRevision || state.value.sessionLease?.sessionId !== turn.sessionId) return err({ kind: "staleTurn" as const });
    const signal = AbortSignal.any([external, AbortSignal.timeout(20000)]);
    let result;
    try { result = await awaitUntilAbort(this.host.readPreviousPractitioner?.({ scope, callId: turn.callId, sessionId: turn.sessionId,
      policyVersion: state.value.policy.policyVersion, turnId: turn.turnId, expectedConversationRevision: expectedRevision, now, signal }) ?? Promise.resolve(undefined), signal); }
    catch { result = undefined; }
    if (signal.aborted) return err({ kind: "staleTurn" as const });
    const interpretation: TurnInterpretation = result?.ok ? result.value.kind === "codeRequired"
      ? { kind: "workflowStarted", operation: "appointments.read", next: "codeRequired" }
      : { kind: "previousPractitioner", snapshot: result.value.snapshot } : { kind: "previousPractitionerUnavailable" };
    return new CallRuntime(this.ledger, scope).acceptTurn(turn, interpretation, now, expectedRevision);
  }

  appointmentEnquiryEnabled(): boolean { return !!this.host.startWorkflow && new AppointmentEnquiryTurns(this.ledger, this.host).enabled(); }
  async enquireAppointments(scope: LocationScope, turn: FinalCallerTurn, request: Readonly<{ from: string; to: string }> | Readonly<{ choice: 1 | 2 | 3 }>,
    now: string, expectedRevision?: number, signal?: AbortSignal) {
    const denied = await this.patientAccessDenied(scope, turn, expectedRevision);
    if (denied) return denied;
    return new AppointmentEnquiryTurns(this.ledger, this.host).accept(scope, turn, request, now, expectedRevision, signal);
  }

  reschedulingMenuEnabled(): boolean {
    return !!this.host.resolveAppointmentChange && new ReschedulingMenuTurns(this.ledger, this.policy, this.host, this.clock).enabled();
  }
  respondPresence(scope: LocationScope, turn: FinalCallerTurn, expectedRevision?: number) {
    return this.respondPublicRepair(scope, turn, "conversationPresence", expectedRevision);
  }
  conversationControlAccepted(turn: FinalCallerTurn, state: CallState): void {
    this.host.conversationControlAccepted?.(turn, state);
  }
  respondMissedCall(scope: LocationScope, turn: FinalCallerTurn, expectedRevision?: number, external?: AbortSignal) {
    return new MissedCallTurns(this.ledger, this.host, this.clock).respond(scope, turn, expectedRevision, external);
  }
  private async respondPublicRepair(scope: LocationScope, turn: FinalCallerTurn, kind: "conversationPresence" | "missedCallReasonUnavailable", expectedRevision?: number) {
    const now = this.currentInstant();
    if (!now || !turn.sessionId || turn.quality !== "clear") return err({ kind: "invalidTransition" as const });
    const state = await this.ledger.read(turn.callId, scope); if (!state.ok) return state;
    if (state.value.lifecycle !== "active" || state.value.sessionLease?.sessionId !== turn.sessionId ||
        Date.parse(state.value.sessionLease.expiresAt) <= Date.parse(now)) return err({ kind: "leaseLost" as const });
    return this.runtime(scope).acceptTurn(turn, { kind }, now, expectedRevision);
  }

  async requestStaff(scope: LocationScope, turn: FinalCallerTurn, requestedPerson: string | undefined, now: string,
    expectedConversationRevision?: number, external?: AbortSignal, requestSubject?: import("../core/staff-request-subject.ts").StaffRequestSubject) {
    if (requestSubject !== undefined && !validStaffRequestSubject(requestSubject)) return err({ kind: "invalidTransition" as const });
    const currentNow = this.currentInstant(); if (!currentNow) return err({ kind: "invalidTransition" as const }); now = currentNow;
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision);
    if (denied) return denied;
    const state = await this.ledger.read(turn.callId, scope);
    if (!state.ok) return state;
    if (state.value.lifecycle !== "active" || state.value.sessionLease?.sessionId !== turn.sessionId || !state.value.sessionLease || Date.parse(state.value.sessionLease.expiresAt) <= Date.parse(now)) return err({ kind: "leaseLost" as const });
    if (turn.quality !== "clear" || !turn.sessionId || expectedConversationRevision !== undefined && state.value.conversationRevision !== expectedConversationRevision) return err({ kind: "staleTurn" as const });
    if (state.value.processedTurnIds.includes(turn.turnId)) return state;
    const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(external ? [external] : [])]);
    if (signal.aborted) return err({ kind: "staleTurn" as const });
    let current: Result<CallState, TransitionFailure> = state;
    if (Object.values(current.value.actions).some(action => ["awaitingConfirmation", "ready"].includes(action.status))) {
      current = await this.runtime(scope).nonAffirmativeFinal(turn, current.value.conversationRevision, now);
      if (!current.ok) return current;
    }
    const revision = current.value.conversationRevision;
    let selected;
    try { selected = await awaitUntilAbort(this.host.prepareStaffRequest?.({ scope, callId: turn.callId, sessionId: turn.sessionId,
      turnId: turn.turnId, callerText: turn.text, policyVersion: state.value.policy.policyVersion, expectedConversationRevision: revision,
      ...(requestedPerson === undefined ? {} : { requestedPerson }), ...(requestSubject === undefined ? {} : { requestSubject }), signal }) ?? Promise.resolve(undefined), signal); }
    catch { selected = undefined; }
    if (external?.aborted) return err({ kind: "staleTurn" as const });
    const finalNow = this.currentInstant(); if (!finalNow) return err({ kind: "invalidTransition" as const });
    if (selected?.ok && (!selected.value || typeof selected.value !== "object" || !["existing", "codeRequired", "ready", "messageNotice"].includes(selected.value.kind))) selected = undefined;
    if (selected?.ok && selected.value.kind === "messageNotice") return validStaffMessageNotice(selected.value.notice)
      ? this.runtime(scope).acceptTurn(turn, { kind: "staffMessageNotice", notice: selected.value.notice }, finalNow, revision)
      : err({ kind: "invalidTransition" as const });
    const typed = selected?.ok && "requestSubject" in selected.value ? selected.value.requestSubject : undefined;
    if (typed !== undefined && !validStaffRequestSubject(typed) || requestSubject !== undefined && selected?.ok && selected.value.kind !== "existing" && typed !== requestSubject) selected = undefined;
    if (selected?.ok && selected.value.kind === "existing" && requestSubject !== undefined &&
        !Object.values(current.value.staffItems).some(item => item.reason === "callerRequested" && item.requestSubject === requestSubject)) selected = undefined;
    if (selected?.ok && selected.value.kind === "existing") return this.staffOutcome(scope, turn, finalNow, revision, external);
    const subject = requestSubject ?? (validStaffRequestSubject(typed) ? typed : undefined), detail = subject === undefined ? {} : { requestSubject: subject };
    const interpretation: TurnInterpretation = !selected?.ok ? { kind: "staffUnavailable", ...detail } : selected.value.kind === "codeRequired"
      ? { kind: "staffVerificationRequired", ...detail, ...("messageDraft" in selected.value && selected.value.messageDraft === true ? { messageDraft: true as const } : {}) } : { kind: "staffRequestReady", ...detail, ...("requestedPerson" in selected.value && selected.value.requestedPerson ? { requestedPerson: selected.value.requestedPerson } : {}) };
    return this.runtime(scope).acceptTurn(turn, interpretation, finalNow, revision);
  }
  staffOutcome(scope: LocationScope, turn: FinalCallerTurn, _now: string, expectedRevision?: number, external?: AbortSignal) {
    return new StaffOutcomeTurns(this.ledger, this.policy, this.host, this.clock).run(scope, turn, expectedRevision, external);
  }
  staffRequestEnabled(): boolean { return typeof this.host.prepareStaffRequest === "function"; }
  async readReschedulingMenu(scope: LocationScope, turn: FinalCallerTurn, stage: "targets" | "practitioners" | "offers", from: string, to: string, now: string, correcting = false, window?: import("../core/booking-search-window.ts").BookingSearchWindow | null, signal?: AbortSignal, nextPractitioners?: true) {
    const denied = await this.patientAccessDenied(scope, turn, undefined);
    if (denied) return denied;
    return new ReschedulingMenuTurns(this.ledger, this.policy, this.host, this.clock).run(scope, turn, now, stage, { from, to, ...(window !== undefined ? { window } : {}), ...(correcting ? { correcting: true as const } : {}), ...(nextPractitioners ? { nextPractitioners } : {}) }, signal);
  }
  async selectReschedulingMenu(scope: LocationScope, turn: FinalCallerTurn, stage: "targets" | "practitioners" | "offers", choice: 1 | 2 | 3, now: string, signal?: AbortSignal) {
    const denied = await this.patientAccessDenied(scope, turn, undefined);
    if (denied) return denied;
    return new ReschedulingMenuTurns(this.ledger, this.policy, this.host, this.clock).run(scope, turn, now, stage, { choice }, signal);
  }

  bookingMenuEnabled(): boolean { return new BookingMenuTurns(this.ledger, this.policy, this.host, this.clock).enabled(); }
  async readBookingMenu(scope: LocationScope, turn: FinalCallerTurn, from: string, to: string, now: string, window?: import("../core/booking-search-window.ts").BookingSearchWindow | null, preference?: import("../core/booking-search-preference.ts").BookingSearchPreference, signal?: AbortSignal) {
    const denied = await this.patientAccessDenied(scope, turn, undefined);
    if (denied) return denied;
    return new BookingMenuTurns(this.ledger, this.policy, this.host, this.clock).run(scope, turn, now, { from, to, ...(window !== undefined ? { window } : {}), ...(preference ? { preference } : {}) }, signal);
  }
  async selectBookingMenu(scope: LocationScope, turn: FinalCallerTurn, choice: 1 | 2 | 3, now: string, signal?: AbortSignal) {
    const denied = await this.patientAccessDenied(scope, turn, undefined);
    if (denied) return denied;
    return new BookingMenuTurns(this.ledger, this.policy, this.host, this.clock).run(scope, turn, now, { choice }, signal);
  }

  availabilityEnabled(): boolean { return this.availability !== undefined; }
  appointmentReadEnabled(): boolean { return this.appointments !== undefined; }
  modelEnabled(): boolean { return this.model !== undefined; }
  cancelPendingModel(scope: LocationScope, callId: string): boolean {
    return this.model?.cancelCall(scope, callId) ?? false;
  }
  staffLifecycleEnabled(): boolean { return !!this.host.advanceTask && !!this.host.reconcileTaskChange; }

  private runtime(scope: LocationScope): CallRuntime {
    return new CallRuntime(this.ledger, scope);
  }

  async startCall(callId: string, scope: LocationScope, now: string = new Date().toISOString()): Promise<Result<CallState, TextReceptionFailure>> {
    const policy = await this.policy.read(scope);
    if (!policy.ok) return policy;
    if (!this.pinKnowledge) return this.runtime(scope).start(callId, policy.value);
    if (!this.knowledge.listModelKnowledge) return err({ kind: "effectFailure" });
    const snapshot = await captureKnowledgeSnapshot(this.knowledge as ModelKnowledgeContextHost, scope, now);
    if (!snapshot.ok) return err({ kind: "effectFailure" });
    return this.runtime(scope).start(callId, { ...policy.value, knowledgeSnapshot: snapshot.value });
  }

  async interpretModelTurn(scope: LocationScope, turn: FinalCallerTurn, now: string,
                           expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision);
    if (denied) return denied;
    if (!this.model) return err({ kind: "effectFailure" });
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (!current.value.policy.automationEnabled || current.value.lifecycle !== "active") return err({ kind: "invalidTransition" });
    if (expectedConversationRevision !== undefined && expectedConversationRevision !== current.value.conversationRevision) return err({ kind: "staleTurn" });
    if (turn.quality !== "clear") {
      const accepted = await runtime.acceptTurn(turn, { kind: "clarify" }, now, expectedConversationRevision);
      if (accepted.ok) this.forgetCanceledModelWork(current.value, accepted.value);
      return accepted;
    }
    const taskRef = modelTaskRef({ scope, turn });
    const interpretation: TurnInterpretation = { kind: "modelPending", taskRef };
    if (current.value.processedTurnIds.includes(turn.turnId)) {
      const prior = await runtime.acceptTurn(turn, interpretation, now);
      return !prior.ok && prior.error.kind === "keyMismatch"
        ? runtime.acceptTurn(turn, { kind: "modelFallback" }, now) : prior;
    }
    let knowledge: readonly { sourceRef: string; approvedText: string }[] = [];
    if (this.knowledge.listModelKnowledge) {
      try {
        const listed = await this.knowledge.listModelKnowledge(scope, now);
        if (!listed.ok || !Array.isArray(listed.value) || listed.value.length > 256 ||
            listed.value.some(source => !validKnowledgeSource(source, scope, now)) ||
            new Set(listed.value.map(source => source.sourceRef)).size !== listed.value.length) {
          const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now, current.value.conversationRevision);
          if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
          return fallback;
        }
        const pinned = listed.value.filter(source => validCallKnowledgeSource(source, current.value.policy, now));
        if (pinned.length > 8) {
          const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now, current.value.conversationRevision);
          if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
          return fallback;
        }
        knowledge = pinned.map(source => ({ sourceRef: source.sourceRef, approvedText: source.approvedText }));
      } catch {
        const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now, current.value.conversationRevision);
        if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
        return fallback;
      }
    }
    const priorCallerTurns = this.model.priorCallerTurns(scope, turn.callId);
    const input = { scope, turn, priorCallerTurns, knowledge, conversationRevision: current.value.conversationRevision + 1,
      policyVersion: current.value.policy.policyVersion, promptVersion: this.model.promptVersion };
    const prepared = this.model.prepare(input);
    if (!prepared.ok) {
      if (prepared.error.kind === "keyMismatch") return err({ kind: "keyMismatch" });
      if (prepared.error.kind === "invalidInput") return err({ kind: "invalidTransition" });
      const fallback = await runtime.acceptTurn(turn, { kind: "modelFallback" }, now,
        current.value.conversationRevision);
      if (fallback.ok) this.forgetCanceledModelWork(current.value, fallback.value);
      return fallback;
    }
    const accepted = await runtime.acceptTurn(turn, interpretation, now, current.value.conversationRevision);
    if (!accepted.ok && prepared.value.created) this.model.forget(taskRef);
    if (accepted.ok) {
      this.model.recordAcceptedTurn(scope, turn.callId, turn.text);
      this.forgetCanceledModelWork(current.value, accepted.value);
    }
    return accepted;
  }

  private forgetCanceledModelWork(before: CallState, after: CallState): void {
    for (const effect of Object.values(before.effects)) {
      if ((effect.kind === "model" || effect.kind === "modelKnowledge") && effect.status === "pending" &&
          after.effects[effect.id]?.status === "canceled") this.model?.forget(effect.taskRef);
    }
  }

  forgetCanceledModelTasks(state: CallState): void {
    for (const effect of Object.values(state.effects)) {
      if ((effect.kind === "model" || effect.kind === "modelKnowledge") && effect.status === "canceled") {
        this.model?.forget(effect.taskRef);
      }
    }
  }

  forgetModelCall(scope: LocationScope, callId: string): void {
    this.model?.forgetCall(scope, callId);
  }

  async proposeBooking(scope: LocationScope, turn: FinalCallerTurn, verificationRef: string, offerRef: string, now: string, expectedConversationRevision?: number, external?: AbortSignal): Promise<Result<CallState, TextReceptionFailure>> {
    if (external?.aborted) return err({ kind: "staleTurn" as const });
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision);
    if (denied) return denied;
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (current.value.policy.capabilities.book === "unavailable") {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: "book" }, now, expectedConversationRevision);
    }
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear") {
      interpretation = { kind: "ambiguousTarget" };
    } else {
      const signal = AbortSignal.any([AbortSignal.timeout(appointmentProposalEvidenceDeadlineMs), ...(external ? [external] : [])]);
      const evidence = await awaitUntilAbort(this.host.resolveBooking(scope, verificationRef, offerRef, now, signal), signal);
      if (external?.aborted) return err({ kind: "staleTurn" as const });
      if (!evidence) return err({ kind: "effectFailure" as const });
      if (evidence.ok) {
        interpretation = { kind: "requestAction", request: evidence.value };
      } else if (evidence.error.kind === "financialConsentRequired") {
        interpretation = { kind: "financialConsentRequired" };
      } else if (evidence.error.kind === "ambiguous" || evidence.error.kind === "expired") {
        interpretation = { kind: "ambiguousTarget" };
      } else {
        interpretation = { kind: "readFailure", target: evidence.error.target, failure: evidence.error.kind === "unavailable" ? "unavailable" : "notFound" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async proposeAppointmentChange(scope: LocationScope, turn: FinalCallerTurn,
                                 selection: AppointmentChangeSelection,
                                 now: string, expectedConversationRevision?: number, external?: AbortSignal): Promise<Result<CallState, TextReceptionFailure>> {
    if (external?.aborted) return err({ kind: "staleTurn" as const });
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision);
    if (denied) return denied;
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (!selection || (selection.kind !== "cancel" && selection.kind !== "reschedule")) {
      return runtime.acceptTurn(turn, { kind: "ambiguousTarget" }, now, expectedConversationRevision);
    }
    if (current.value.policy.capabilities[selection.kind] === "unavailable" || !this.host.resolveAppointmentChange) {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: selection.kind }, now, expectedConversationRevision);
    }
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || !turn.sessionId ||
        current.value.sessionLease?.sessionId !== turn.sessionId ||
        !validIntakeRef(selection.verificationRef) || !validIntakeRef(selection.targetRef) ||
        (selection.kind === "reschedule" && !validIntakeRef(selection.offerRef))) {
      interpretation = { kind: "ambiguousTarget" };
    } else {
      try {
        const context = { scope, callId: turn.callId, sessionId: turn.sessionId,
          policyVersion: current.value.policy.policyVersion, now };
        const query: AppointmentChangeEvidenceQuery = selection.kind === "cancel"
          ? { ...context, kind: "cancel", verificationRef: selection.verificationRef,
            targetRef: selection.targetRef }
          : { ...context, kind: "reschedule", verificationRef: selection.verificationRef,
            targetRef: selection.targetRef, offerRef: selection.offerRef };
        const signal = AbortSignal.any([AbortSignal.timeout(appointmentProposalEvidenceDeadlineMs), ...(external ? [external] : [])]);
        const evidence = await awaitUntilAbort(this.host.resolveAppointmentChange(query, signal), signal);
        if (external?.aborted) return err({ kind: "staleTurn" as const });
        if (!evidence) return err({ kind: "effectFailure" as const });
        if (!evidence.ok) {
          interpretation = evidence.error.kind === "ambiguous" || evidence.error.kind === "expired"
            ? { kind: "ambiguousTarget" }
            : { kind: "readFailure", target: evidence.error.target,
              failure: evidence.error.kind === "unavailable" ? "unavailable" : "notFound" };
        } else if (evidence.value.kind !== selection.kind ||
                   appointmentChangeEvidenceFailure(scope, evidence.value, now)) {
          interpretation = { kind: "readFailure", target: "appointment", failure: "unavailable" };
        } else interpretation = { kind: "requestAction", request: evidence.value };
      } catch {
        if (external?.aborted) return err({ kind: "staleTurn" as const });
        interpretation = { kind: "readFailure", target: "appointment", failure: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async proposeIntake(scope: LocationScope, turn: FinalCallerTurn, draftRef: string, now: string,
                      expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision);
    if (denied) return denied;
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (current.value.policy.capabilities.intake === "unavailable" || !this.host.resolveIntake) {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: "intake" }, now, expectedConversationRevision);
    }
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || typeof turn.sessionId !== "string" || !turn.sessionId.trim() ||
        current.value.sessionLease?.sessionId !== turn.sessionId ||
        !validIntakeRef(draftRef)) {
      interpretation = { kind: "intakeFailure", reason: "missing" };
    } else {
      try {
        const evidence = await this.host.resolveIntake({ scope, callId: turn.callId, sessionId: turn.sessionId,
          policyVersion: current.value.policy.policyVersion, draftRef, now });
        if (evidence.ok && evidence.value.kind === "intake" &&
            evidence.value.scope.tenantId === scope.tenantId && evidence.value.scope.clinicId === scope.clinicId &&
            evidence.value.scope.locationId === scope.locationId && evidence.value.approvedDraftRef === draftRef &&
            validIntakeRef(evidence.value.consentRef) && validIntakeRef(evidence.value.duplicateCheckRef)) {
          interpretation = { kind: "requestAction", request: evidence.value };
        } else {
          interpretation = { kind: "intakeFailure", reason: !evidence.ok && evidence.error.kind !== "unavailable" ? "missing" : "unavailable" };
        }
      } catch {
        interpretation = { kind: "intakeFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  patientCorrectionEnabled(): boolean { return typeof this.host.resolvePatientCorrection === "function"; }
  async proposePatientCorrection(scope: LocationScope, turn: FinalCallerTurn, correctionRef: string, now: string,
                                expectedConversationRevision?: number, external?: AbortSignal): Promise<Result<CallState, TextReceptionFailure>> {
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision); if (denied) return denied;
    const runtime = this.runtime(scope), state = await runtime.read(turn.callId); if (!state.ok) return state;
    if (state.value.policy.capabilities.patientUpdate !== "execute" || !this.host.resolvePatientCorrection) {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: "patientUpdate" }, now, expectedConversationRevision);
    }
    if (turn.quality !== "clear" || typeof turn.sessionId !== "string" || state.value.sessionLease?.sessionId !== turn.sessionId ||
        typeof correctionRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(correctionRef)) return err({ kind: "invalidTransition" });
    const signal = external ? AbortSignal.any([external, AbortSignal.timeout(appointmentProposalEvidenceDeadlineMs)]) : AbortSignal.timeout(appointmentProposalEvidenceDeadlineMs);
    let interpretation: TurnInterpretation = { kind: "readFailure", target: "patient", failure: "unavailable" };
    try {
      const evidence = await awaitUntilAbort(this.host.resolvePatientCorrection({ scope, callId: turn.callId, sessionId: turn.sessionId,
        policyVersion: state.value.policy.policyVersion, correctionRef, now }), signal);
      if (external?.aborted) return err({ kind: "staleTurn" });
      if (evidence?.ok && evidence.value.correctionRef === correctionRef && !patientCorrectionEvidenceFailure(scope, evidence.value, now)) {
        interpretation = { kind: "requestAction", request: evidence.value };
      }
    } catch { if (external?.aborted) return err({ kind: "staleTurn" }); }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  confirmationResendEnabled(): boolean { return typeof this.host.resolveConfirmationResend === "function"; }
  async proposeConfirmationResend(scope: LocationScope, turn: FinalCallerTurn, requestRef: string, now: string,
    expectedConversationRevision?: number, external?: AbortSignal): Promise<Result<CallState, TextReceptionFailure>> {
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision); if (denied) return denied;
    const runtime = this.runtime(scope), state = await runtime.read(turn.callId); if (!state.ok) return state;
    if (state.value.policy.capabilities.confirmationResend !== "execute" || !this.host.resolveConfirmationResend) {
      return runtime.acceptTurn(turn, { kind: "unavailableAction", actionKind: "confirmationResend" }, now, expectedConversationRevision);
    }
    if (turn.quality !== "clear" || typeof turn.sessionId !== "string" || state.value.sessionLease?.sessionId !== turn.sessionId ||
        typeof requestRef !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestRef)) return err({ kind: "invalidTransition" });
    const signal = external ? AbortSignal.any([external, AbortSignal.timeout(appointmentProposalEvidenceDeadlineMs)]) : AbortSignal.timeout(appointmentProposalEvidenceDeadlineMs);
    let interpretation: TurnInterpretation = { kind: "readFailure", target: "patient", failure: "unavailable" };
    try {
      const evidence = await awaitUntilAbort(this.host.resolveConfirmationResend({ scope, callId: turn.callId, sessionId: turn.sessionId,
        policyVersion: state.value.policy.policyVersion, requestRef, now }), signal);
      if (external?.aborted) return err({ kind: "staleTurn" });
      if (evidence?.ok && evidence.value.requestRef === requestRef && !confirmationResendEvidenceFailure(state.value.policy, evidence.value, now)) {
        interpretation = { kind: "requestAction", request: evidence.value };
      }
    } catch { if (external?.aborted) return err({ kind: "staleTurn" }); }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async answer(scope: LocationScope, turn: FinalCallerTurn, sourceRefs: readonly string[], proposedText: string, now: string, expectedConversationRevision?: number, external?: AbortSignal): Promise<Result<CallState, TextReceptionFailure>> {
    const topic = publicInformationTopic(sourceRefs);
    if (topic) return new PublicInformationAnswers(this.ledger, this.knowledge, this.clock).run(scope, turn, topic, proposedText, expectedConversationRevision, external);
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || !Array.isArray(sourceRefs) || sourceRefs.length < 1 || sourceRefs.length > 8 ||
        sourceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 256) || new Set(sourceRefs).size !== sourceRefs.length ||
        typeof proposedText !== "string" || !proposedText.trim() || proposedText.length > 2_000) {
      interpretation = { kind: "knowledgeFailure", reason: "invalidQuery" };
    } else {
      try {
        const read = await this.knowledge.readKnowledge(scope, sourceRefs);
        interpretation = read.ok
          ? { kind: "answer", sources: read.value, proposedText }
          : { kind: "knowledgeFailure", reason: read.error.kind };
      } catch {
        interpretation = { kind: "knowledgeFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async checkAvailability(scope: LocationScope, turn: FinalCallerTurn, from: string, to: string, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear") {
      interpretation = { kind: "availabilityFailure", reason: "unclear" };
    } else if (typeof from !== "string" || typeof to !== "string" || !this.availability) {
      interpretation = { kind: "availabilityFailure", reason: this.availability ? "invalidRange" : "notConfigured" };
    } else {
      try {
        const read = await this.availability.list(scope, from, to);
        if (!read.ok) interpretation = { kind: "availabilityFailure", reason: read.error.kind };
        else if (read.value.kind === "times") interpretation = { kind: "availability", from, to, snapshot: read.value };
        else interpretation = { kind: "availabilityFailure", reason: "notEligible" };
      } catch {
        interpretation = { kind: "availabilityFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async checkAppointments(scope: LocationScope, turn: FinalCallerTurn, verificationRef: string, from: string, to: string, now: string,
                          expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const startedAt = this.currentInstant();
    if (!startedAt) return err({ kind: "invalidTransition" as const });
    now = startedAt;
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision);
    if (denied) return denied;
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear") {
      interpretation = { kind: "appointmentsFailure", reason: "unclear" };
    } else if (!this.appointments) {
      interpretation = { kind: "appointmentsFailure", reason: "notConfigured" };
    } else {
      try {
        const read = await this.appointments.list(scope, verificationRef, from, to, now);
        interpretation = read.ok
          ? { kind: "appointments", from, to, snapshot: read.value }
          : { kind: "appointmentsFailure", reason: read.error.kind };
      } catch {
        interpretation = { kind: "appointmentsFailure", reason: "unavailable" };
      }
    }
    // Provider reads can finish after the speech turn. Neither the old turn
    // timestamp nor a returned snapshot supplies current presentation authority.
    const completedAt = this.currentInstant();
    if (!completedAt || Date.parse(completedAt) < Date.parse(startedAt)) return err({ kind: "invalidTransition" as const });
    return runtime.acceptTurn(turn, interpretation, completedAt, expectedConversationRevision);
  }

  async selectAppointment(scope: LocationScope, turn: FinalCallerTurn, verificationRef: string, choice: 1 | 2 | 3,
                          now: string, expectedConversationRevision?: number): Promise<Result<CallState, TextReceptionFailure>> {
    const denied = await this.patientAccessDenied(scope, turn, expectedConversationRevision);
    if (denied) return denied;
    const runtime = this.runtime(scope);
    const current = await runtime.read(turn.callId);
    if (!current.ok) return current;
    if (current.value.lifecycle !== "active") return err({ kind: "invalidTransition" });
    if (expectedConversationRevision !== undefined &&
        current.value.conversationRevision !== expectedConversationRevision) return err({ kind: "staleTurn" });
    const last = current.value.appointmentReads.at(-1);
    const notice = last ? current.value.presentations[noticePresentationId(turn.callId, last.turnId)] : undefined;
    let interpretation: TurnInterpretation;
    if (turn.quality !== "clear" || !this.appointments?.select ||
        !last || last.status !== "shown" || (last.shownCount ?? 0) < 2 ||
        current.value.processedTurnIds.at(-1) !== last.turnId ||
        current.value.pendingPresentationId || notice?.status !== "played" ||
        ![1, 2, 3].includes(choice)) {
      interpretation = { kind: "appointmentsFailure", reason: "notFound" };
    } else {
      try {
        const selected = await this.appointments.select(scope, verificationRef, choice, now);
        if (!selected.ok) interpretation = { kind: "appointmentsFailure", reason: selected.error.kind };
        else if (selected.value.snapshot?.verificationRef !== verificationRef ||
                 selected.value.snapshot.appointments?.length !== 1) {
          interpretation = { kind: "appointmentsFailure", reason: "malformed" };
        } else interpretation = { kind: "appointments", ...selected.value };
      } catch {
        interpretation = { kind: "appointmentsFailure", reason: "unavailable" };
      }
    }
    return runtime.acceptTurn(turn, interpretation, now, expectedConversationRevision);
  }

  async acknowledgeTextPresentation(scope: LocationScope, callId: string, presentationId: string): Promise<Result<CallState, TransitionFailure>> {
    const runtime = this.runtime(scope);
    const started = await runtime.startPresentation(callId, presentationId);
    if (!started.ok) return started;
    return runtime.resolvePresentation(callId, presentationId, "played");
  }

  completeTextPresentation(scope: LocationScope, callId: string, presentationId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).completeTextPresentation(callId, presentationId, now);
  }

  continueClassMovement(scope: LocationScope, turn: FinalCallerTurn, expectedConversationRevision?: number, external?: AbortSignal) {
    return new ClassMovementTurns(this.ledger, this.policy, this.host, this.clock).run(scope, turn, expectedConversationRevision, external);
  }
  async affirm(scope: LocationScope, turn: FinalCallerTurn, actionKey: string, digest: string, now: string, expectedConversationRevision?: number, external?: AbortSignal): Promise<Result<CallState, TransitionFailure>> {
    const runtime = this.runtime(scope);
    if (this.host.prepareClassMovement) {
      const found = await runtime.read(turn.callId);
      const phase = found.ok ? found.value.actions[actionKey] : undefined;
      if (phase?.classMovementConsent && phase.classMovement?.outcome === "pending")
        return runtime.acceptTurn(turn, { kind: "classMovementAffirm", actionKey, digest }, now, expectedConversationRevision);
    }
    if (!this.host.checkConfirmationCapacity) return runtime.acceptTurn(turn, { kind: "affirm", actionKey, digest, affirmative: true }, now, expectedConversationRevision);
    const state = await runtime.read(turn.callId); if (!state.ok) return state;
    if (expectedConversationRevision !== undefined && expectedConversationRevision !== state.value.conversationRevision) return err({ kind: "staleTurn" });
    const action = state.value.actions[actionKey];
    if (!turn.sessionId || action?.status !== "awaitingConfirmation" || action.digest !== digest || state.value.presentations[action.presentationId]?.status !== "played" || state.value.pendingPresentationId) return err({ kind: "confirmationMissing" });
    const revision = state.value.conversationRevision;
    const signal = AbortSignal.any([AbortSignal.timeout(5000), ...(external ? [external] : [])]);
    let interpretation: TurnInterpretation = { kind: "readFailure", target: "appointment", failure: "unavailable" };
    try {
      const capacity = await awaitUntilAbort(this.host.checkConfirmationCapacity({ scope, callId: turn.callId, sessionId: turn.sessionId,
        turnId: turn.turnId, policyVersion: state.value.policy.policyVersion, now, signal, actionKey, digest }), signal);
      if (external?.aborted) return err({ kind: "staleTurn" });
      if (capacity?.ok && capacity.value.kind === "ready") interpretation = { kind: "affirm", actionKey, digest, affirmative: true };
      else if (capacity?.ok && capacity.value.kind === "wait") interpretation = { kind: "confirmationWait", actionKey, digest, seconds: capacity.value.seconds };
      else if (capacity && !capacity.ok && capacity.error.kind === "expired") interpretation = { kind: "clarify", reason: "menuUnavailable" };
    } catch { if (external?.aborted) return err({ kind: "staleTurn" }); }
    return runtime.acceptTurn(turn, interpretation, now, revision);
  }

  async drain(scope: LocationScope, callId: string, now: string): Promise<Result<CallState, TextReceptionFailure>> {
    const runtime = this.runtime(scope);
    try {
      const leased = await this.effectLeases.run(callId, scope, async (signal, guard) => {
        const read = await runtime.read(callId);
        if (!read.ok) return read;
        const worker = new EffectWorker(runtime, this.host, this.model, this.knowledge, { signal, leaseGuard: guard, clock: this.clock });
        for (const effect of Object.values(read.value.effects)) {
          if (effect.status !== "pending") continue;
          try {
            if (await worker.process(callId, effect.id, now) === "canceled") break;
          }
          catch { return err({ kind: "effectFailure" as const }); }
        }
        return runtime.read(callId);
      });
      if (!leased.ok) return leased;
      if (leased.value.kind === "busy") return runtime.read(callId);
      return leased.value.kind === "lost" ? err({ kind: "effectFailure" }) : leased.value.value;
    } catch { return err({ kind: "effectFailure" }); }
  }

  async changeStaff(scope: LocationScope, callId: string, expectedVersion: number, taskKey: string, actorRef: string,
                    change: StaffChangeRequest, now: string): Promise<Result<CallState, TextReceptionFailure>> {
    if (!this.staffLifecycleEnabled() || !Number.isFinite(Date.parse(now))) return err({ kind: "invalidTransition" });
    const runtime = this.runtime(scope);
    const requested = await runtime.requestStaffChange(callId, expectedVersion, taskKey, actorRef, change);
    if (!requested.ok) return requested;
    const item = requested.value.staffItems[taskKey];
    const effectId = item?.pendingChangeKey ? `${item.pendingChangeKey}:send` : undefined;
    if (!effectId) return err({ kind: "effectFailure" });
    try {
      await this.effectLeases.run(callId, scope, (signal, guard) =>
        new EffectWorker(runtime, this.host, undefined, undefined, { signal, leaseGuard: guard, clock: this.clock }).process(callId, effectId, now));
    }
    catch { /* The persisted intent remains available to the recovery worker. */ }
    return runtime.read(callId);
  }

  read(scope: LocationScope, callId: string): Promise<Result<CallState, TransitionFailure>> {
    return this.runtime(scope).read(callId);
  }
}
