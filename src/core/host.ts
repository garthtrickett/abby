import type { ActionRequest, ApprovedKnowledge, AvailabilityRead, AvailabilityReadFailure, BookableOffer, CallPolicy, HostMutation, HostWriteReceipt, LocationScope, OperatorAlert, OperatorAlertObservation, OperatorAlertReceipt, ReconcileObservation, Result, StaffChange, StaffChangeObservation, StaffChangeReceipt, StaffItem, StaffTaskObservation, StaffTaskReceipt, VerifiedPatient } from "./model.ts";

export type HostReadFailure = Readonly<{ kind: "notFound" | "ambiguous" | "expired" | "unavailable"; target: "patient" | "offer" }>;
export type PolicyFailure = Readonly<{ kind: "versionConflict" | "invalidValue" | "storageFailure" }>;
export type KnowledgeReadFailure = Readonly<{ kind: "invalidQuery" | "unavailable" }>;

export interface KnowledgeHost {
  readKnowledge(scope: LocationScope, sourceRefs: readonly string[]): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>>;
}

export interface AvailabilityHost {
  list(scope: LocationScope, from: string, to: string): Promise<Result<AvailabilityRead, AvailabilityReadFailure>>;
}

export interface BookingEvidenceHost {
  resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>>;
}

export interface HostEffects {
  write(mutation: HostMutation, now: string): Promise<HostWriteReceipt>;
  reconcile(mutation: HostMutation): Promise<ReconcileObservation>;
  openTask(item: StaffItem): Promise<StaffTaskReceipt>;
  reconcileTask(item: StaffItem): Promise<StaffTaskObservation>;
}

export interface StaffLifecycleHost {
  advanceTask(change: StaffChange): Promise<StaffChangeReceipt>;
  reconcileTaskChange(change: StaffChange): Promise<StaffChangeObservation>;
}

export interface OperatorAlertHost {
  sendAlert(alert: OperatorAlert): Promise<OperatorAlertReceipt>;
  reconcileAlert(alert: OperatorAlert): Promise<OperatorAlertObservation>;
}

export interface PolicyStore {
  read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>>;
  changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean): Promise<Result<CallPolicy, PolicyFailure>>;
}
