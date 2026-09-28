import type { CallPolicy, CallState, FinalCallerTurn, HostWriteReceipt, LocationScope, ReconcileObservation, Result, StaffTaskReceipt, TransitionAction, TransitionFailure, TurnInterpretation } from "./model.ts";
import type { LedgerStore } from "./ledger.ts";

export class CallRuntime {
  private readonly ledger: LedgerStore;
  private readonly scope: LocationScope;

  constructor(ledger: LedgerStore, scope: LocationScope) {
    this.ledger = ledger;
    this.scope = scope;
  }

  start(callId: string, policy: CallPolicy): Promise<Result<CallState, TransitionFailure>> {
    if (policy.scope.tenantId !== this.scope.tenantId || policy.scope.clinicId !== this.scope.clinicId || policy.scope.locationId !== this.scope.locationId) {
      return Promise.resolve({ ok: false, error: { kind: "scopeMismatch" } });
    }
    return this.ledger.start(callId, policy);
  }

  read(callId: string): Promise<Result<CallState, TransitionFailure>> {
    return this.ledger.read(callId, this.scope);
  }

  apply(callId: string, expectedVersion: number, action: TransitionAction): Promise<Result<CallState, TransitionFailure>> {
    return this.ledger.apply(callId, this.scope, expectedVersion, action);
  }

  private async update(callId: string, action: TransitionAction): Promise<Result<CallState, TransitionFailure>> {
    const current = await this.ledger.read(callId, this.scope);
    if (!current.ok) return current;
    return this.ledger.apply(callId, this.scope, current.value.version, action);
  }

  acceptTurn(turn: FinalCallerTurn, interpretation: TurnInterpretation, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(turn.callId, { kind: "callerTurn", turn, interpretation, now });
  }

  startPresentation(callId: string, presentationId: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "presentationStarted", presentationId });
  }

  resolvePresentation(callId: string, presentationId: string, status: "played" | "interrupted" | "failed"): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "presentationResolved", presentationId, status });
  }

  markHostPossiblySent(callId: string, effectId: string, now: string): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "markHostPossiblySent", effectId, now });
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

  acceptStaffResult(callId: string, effectId: string, receipt: StaffTaskReceipt): Promise<Result<CallState, TransitionFailure>> {
    return this.update(callId, { kind: "staffTaskResolved", effectId, receipt });
  }
}
