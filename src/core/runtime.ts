import type { CallPolicy, CallState, FinalCallerTurn, HostWriteReceipt, ReconcileObservation, Result, StaffTaskReceipt, TransitionAction, TransitionFailure, TurnInterpretation } from "./model.ts";
import type { LedgerStore } from "./ledger.ts";

export class CallRuntime {
  private readonly ledger: LedgerStore;

  constructor(ledger: LedgerStore) {
    this.ledger = ledger;
  }

  start(callId: string, policy: CallPolicy): Result<CallState, TransitionFailure> {
    return this.ledger.start(callId, policy);
  }

  read(callId: string): Result<CallState, TransitionFailure> {
    return this.ledger.read(callId);
  }

  apply(callId: string, expectedVersion: number, action: TransitionAction): Result<CallState, TransitionFailure> {
    return this.ledger.apply(callId, expectedVersion, action);
  }

  private update(callId: string, action: TransitionAction): Result<CallState, TransitionFailure> {
    const current = this.ledger.read(callId);
    if (!current.ok) return current;
    return this.ledger.apply(callId, current.value.version, action);
  }

  acceptTurn(turn: FinalCallerTurn, interpretation: TurnInterpretation, now: string): Result<CallState, TransitionFailure> {
    return this.update(turn.callId, { kind: "callerTurn", turn, interpretation, now });
  }

  startPresentation(callId: string, presentationId: string): Result<CallState, TransitionFailure> {
    return this.update(callId, { kind: "presentationStarted", presentationId });
  }

  resolvePresentation(callId: string, presentationId: string, status: "played" | "interrupted" | "failed"): Result<CallState, TransitionFailure> {
    return this.update(callId, { kind: "presentationResolved", presentationId, status });
  }

  markHostPossiblySent(callId: string, effectId: string, now: string): Result<CallState, TransitionFailure> {
    return this.update(callId, { kind: "markHostPossiblySent", effectId, now });
  }

  acceptHostResult(callId: string, effectId: string, receipt: HostWriteReceipt, now: string): Result<CallState, TransitionFailure> {
    return this.update(callId, { kind: "hostWriteResolved", effectId, receipt, now });
  }

  acceptReconciliation(callId: string, effectId: string, observation: ReconcileObservation, now: string): Result<CallState, TransitionFailure> {
    return this.update(callId, { kind: "reconciliationResolved", effectId, observation, now });
  }

  expireReconciliation(callId: string, actionKey: string, now: string): Result<CallState, TransitionFailure> {
    return this.update(callId, { kind: "reconciliationDeadline", actionKey, now });
  }

  markStaffPossiblySent(callId: string, effectId: string): Result<CallState, TransitionFailure> {
    return this.update(callId, { kind: "markStaffPossiblySent", effectId });
  }

  acceptStaffResult(callId: string, effectId: string, receipt: StaffTaskReceipt): Result<CallState, TransitionFailure> {
    return this.update(callId, { kind: "staffTaskResolved", effectId, receipt });
  }
}
