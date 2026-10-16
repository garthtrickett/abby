import type { Admission, AdmissionResult, CallPolicy, CallState, FinalCallerTurn, HostWriteReceipt, LocationScope, OperatorAlertObservation, OperatorAlertReceipt, ReconcileObservation, Result, StaffAlertReason, StaffChangeObservation, StaffChangeReceipt, StaffChangeRequest, StaffTaskObservation, StaffTaskReceipt, TransitionAction, TransitionFailure, TurnInterpretation } from "./model.ts";
import type { LedgerStore } from "./ledger.ts";
import type { EffectCallLeaseGuard } from "./effect-call-lease.ts";
import { validKnowledgeSnapshot } from "./knowledge-evidence.ts";

export class CallRuntime {
  private readonly ledger: LedgerStore;
  private readonly scope: LocationScope;
  private readonly effectLease: EffectCallLeaseGuard | undefined;

  constructor(ledger: LedgerStore, scope: LocationScope, effectLease?: EffectCallLeaseGuard) {
    this.ledger = ledger;
    this.scope = scope;
    this.effectLease = effectLease;
  }

  withEffectLease(guard: EffectCallLeaseGuard): CallRuntime {
    return new CallRuntime(this.ledger, this.scope, guard);
  }

  start(callId: string, policy: CallPolicy): Promise<Result<CallState, TransitionFailure>> {
    if (policy.scope.tenantId !== this.scope.tenantId || policy.scope.clinicId !== this.scope.clinicId || policy.scope.locationId !== this.scope.locationId) {
      return Promise.resolve({ ok: false, error: { kind: "scopeMismatch" } });
    }
    if (policy.knowledgeSnapshot !== undefined && !validKnowledgeSnapshot(policy.knowledgeSnapshot)) {
      return Promise.resolve({ ok: false, error: { kind: "invalidTransition" } });
    }
    return this.ledger.start(callId, policy);
  }

  admit(callId: string, policy: CallPolicy, admission: Admission): Promise<Result<AdmissionResult, TransitionFailure>> {
    if (policy.scope.tenantId !== this.scope.tenantId || policy.scope.clinicId !== this.scope.clinicId || policy.scope.locationId !== this.scope.locationId) {
      return Promise.resolve({ ok: false, error: { kind: "scopeMismatch" } });
    }
    if (policy.knowledgeSnapshot !== undefined && !validKnowledgeSnapshot(policy.knowledgeSnapshot)) {
      return Promise.resolve({ ok: false, error: { kind: "invalidTransition" } });
    }
    return this.ledger.admit(callId, policy, admission);
  }

  activate(callId: string, sessionId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "sessionActivated", sessionId, now });
  }

  renewSession(callId: string, sessionId: string, expectedLeaseVersion: number, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "sessionRenewed", sessionId, expectedLeaseVersion, now });
  }

  expireAdmission(callId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "admissionExpired", now });
  }

  expireSession(callId: string, sessionId: string, expectedLeaseVersion: number, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "sessionExpired", sessionId, expectedLeaseVersion, now });
  }

  async endCall(callId: string, sessionId: string, now: string,
          reason: "callerDisconnected" | "sessionClosed" | "mediaFailure" | "localLeaseClosed" = "sessionClosed"): Promise<Result<CallState, TransitionFailure>> {
    // A stopping provider effect can settle concurrently. Retry only this local
    // terminal transition; every apply rechecks the current session ownership.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ended = await this.update(callId, { kind: "callEnded", sessionId, reason, now });
      if (ended.ok || ended.error.kind !== "versionConflict") return ended;
    }
    return { ok: false, error: { kind: "versionConflict" } };
  }

  completeTextPresentation(callId: string, presentationId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "textPresentationWritten", presentationId, now });
  }

  beginSpeech(callId: string, sessionId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "speechBegan", sessionId, now });
  }
  /** Fence a prior unsent proposal before any asynchronous intent interpretation. */
  nonAffirmativeFinal(turn: FinalCallerTurn, expectedConversationRevision: number, now: string) {
    return this.update(turn.callId, { kind: "nonAffirmativeFinal", turn, expectedConversationRevision, now });
  }

  silenceTimeout(callId: string, sessionId: string, stage: "retry" | "final", now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "silenceTimeout", sessionId, stage, now });
  }

  read(callId: string): Promise<Result<CallState, TransitionFailure>> {
    return this.ledger.read(callId, this.scope);
  }

  apply(callId: string, expectedVersion: number, action: TransitionAction): Promise<Result<CallState, TransitionFailure>> {
    return this.ledger.apply(callId, this.scope, expectedVersion, action, this.effectLease);
  }

  private async update(callId: string, action: TransitionAction): Promise<Result<CallState, TransitionFailure>> {
    const current = await this.ledger.read(callId, this.scope);
    if (!current.ok) return current;
    const applied = await this.ledger.apply(callId, this.scope, current.value.version, action, this.effectLease);
    if (applied.ok || applied.error.kind !== "versionConflict" || action.kind === "sessionRenewed") return applied;
    const latest = await this.ledger.read(callId, this.scope);
    if (!latest.ok) return applied;
    const before = current.value, after = latest.value;
    // Exactly one sessionRenewed transition can advance both these versions
    // by one without changing the conversation. Recheck the same action once
    // against that lease advance; every transition and effect-lease guard
    // still runs. Other concurrent changes keep their original conflict.
    if (before.lifecycle !== "active" || after.lifecycle !== "active" ||
        !before.sessionLease || !after.sessionLease ||
        after.version !== before.version + 1 || after.conversationRevision !== before.conversationRevision ||
        after.sessionLease.sessionId !== before.sessionLease.sessionId ||
        after.sessionLease.version !== before.sessionLease.version + 1) return applied;
    return this.ledger.apply(callId, this.scope, after.version, action, this.effectLease);
  }

  acceptTurn(turn: FinalCallerTurn, interpretation: TurnInterpretation, now: string, expectedConversationRevision?: number): Promise<Result<CallState, TransitionFailure>> {
    return this.update(turn.callId, { kind: "callerTurn", turn, interpretation, now, ...(expectedConversationRevision === undefined ? {} : { expectedConversationRevision }) });
  }

  /** The trusted voice owner retains the text; SAM tracks only this opaque playback receipt. */
  privateIntakePrompt(callId: string, presentationId: string, sessionId: string, now: string) {
    return this.update(callId, { kind: "privateIntakePrompt", presentationId, sessionId, now });
  }
  privateCorrectionPrompt(callId: string, presentationId: string, sessionId: string, now: string) {
    return this.update(callId, { kind: "privateCorrectionPrompt", presentationId, sessionId, now });
  }
  privateResendPrompt(callId: string, presentationId: string, sessionId: string, now: string) {
    return this.update(callId, { kind: "privateResendPrompt", presentationId, sessionId, now });
  }
  privateRepresentativePrompt(callId: string, presentationId: string, sessionId: string, operation: "book" | "cancel" | "reschedule" | "appointments.read", now: string) {
    return this.update(callId, { kind: "privateRepresentativePrompt", presentationId, sessionId, operation, now });
  }

  acceptModelResult(callId: string, effectId: string,
                    result: Extract<TransitionAction, { kind: "modelResolved" }>["result"], now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "modelResolved", effectId, result, now });
  }

  acceptModelKnowledge(callId: string, effectId: string,
                       result: Extract<TransitionAction, { kind: "modelKnowledgeResolved" }>["result"], now: string,
                       proposedText?: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "modelKnowledgeResolved", effectId, result, now,
      ...(proposedText === undefined ? {} : { proposedText }) });
  }

  startPresentation(callId: string, presentationId: string, sessionId?: string, now?: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "presentationStarted", presentationId, ...(sessionId === undefined ? {} : { sessionId }), ...(now === undefined ? {} : { now }) });
  }

  markTransferPossiblySent(callId: string, presentationId: string, sessionId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "transferPossiblySent", presentationId, sessionId, now });
  }

  resolvePresentation(callId: string, presentationId: string, status: "played" | "interrupted" | "failed" | "unproven" | "connected" | "canceled", sessionId?: string, now?: string, providerConnectionRef?: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "presentationResolved", presentationId, status, ...(sessionId === undefined ? {} : { sessionId }), ...(now === undefined ? {} : { now }), ...(providerConnectionRef === undefined ? {} : { providerConnectionRef }) });
  }

  markHostPossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "markHostPossiblySent", effectId, now });
  }

  notificationAction(callId: string, action: import("./notification-effects.ts").NotificationTransitionAction):
    Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, action);
  }

  recoverHostPossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "recoverHostPossiblySent", effectId, now });
  }

  acceptHostResult(callId: string, effectId: string, receipt: HostWriteReceipt, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "hostWriteResolved", effectId, receipt, now });
  }

  acceptReconciliation(callId: string, effectId: string, observation: ReconcileObservation, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "reconciliationResolved", effectId, observation, now });
  }

  expireReconciliation(callId: string, actionKey: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "reconciliationDeadline", actionKey, now });
  }

  markStaffPossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "markStaffPossiblySent", effectId, now });
  }

  recoverStaffPossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "recoverStaffPossiblySent", effectId, now });
  }

  acceptStaffResult(callId: string, effectId: string, receipt: StaffTaskReceipt, now?: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "staffTaskResolved", effectId, receipt, ...(now === undefined ? {} : { now }) });
  }

  acceptStaffReconciliation(callId: string, effectId: string, observation: StaffTaskObservation): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "staffTaskReconciled", effectId, observation });
  }

  requestStaffChange(callId: string, expectedVersion: number, taskKey: string, actorRef: string, change: StaffChangeRequest): Promise<Result<CallState, TransitionFailure>> {
    return this.apply(callId, expectedVersion, { kind: "staffChangeRequested", taskKey, actorRef, change });
  }

  markStaffChangePossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "markStaffChangePossiblySent", effectId, now });
  }

  recoverStaffChangePossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "recoverStaffChangePossiblySent", effectId, now });
  }

  acceptStaffChangeResult(callId: string, effectId: string, receipt: StaffChangeReceipt): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "staffChangeResolved", effectId, receipt });
  }

  acceptStaffChangeReconciliation(callId: string, effectId: string, observation: StaffChangeObservation): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "staffChangeReconciled", effectId, observation });
  }

  requestStaffAlert(callId: string, taskKey: string, reason: StaffAlertReason, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "staffAlertRequested", taskKey, reason, now });
  }

  markOperatorAlertPossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "markOperatorAlertPossiblySent", effectId, now });
  }

  recoverOperatorAlertPossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "recoverOperatorAlertPossiblySent", effectId, now });
  }

  acceptOperatorAlertResult(callId: string, effectId: string, receipt: OperatorAlertReceipt, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "operatorAlertResolved", effectId, receipt, now });
  }

  acceptOperatorAlertReconciliation(callId: string, effectId: string, observation: OperatorAlertObservation, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "operatorAlertReconciled", effectId, observation, now });
  }
}
