import type { ActionRequest, ApprovedKnowledge, AppointmentRead, AppointmentReadFailure, AvailabilityRead, AvailabilityReadFailure, BookableOffer, CallPolicy, HostMutation, HostWriteReceipt, LocationScope, OperatorAlert, OperatorAlertObservation, OperatorAlertReceipt, ReconcileObservation, Result, StaffChange, StaffChangeObservation, StaffChangeReceipt, StaffItem, StaffTaskObservation, StaffTaskReceipt, VerifiedPatient } from "./model.ts";
import type { ReadinessFailure } from "./readiness.ts";

export type HostReadFailure = Readonly<{ kind: "notFound" | "ambiguous" | "expired" | "unavailable"; target: "patient" | "offer" }>;
export type PolicyFailure = Readonly<{ kind: "versionConflict" | "invalidValue" | "storageFailure" }> | ReadinessFailure;
export type AutomationSettingAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  previousEnabled: boolean;
  actorRef: string;
  changedAt: string;
}>;
export type AutomationSettingAuditPage = Readonly<{ entries: readonly AutomationSettingAuditEntry[]; nextAfterVersion?: number }>;
export type BookingSettingAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  provenance: "recorded" | "legacyUnattributed";
  actorRef?: string;
  previousEnabled?: boolean;
  changedAt?: string;
}>;
export type BookingSettingAuditPage = Readonly<{ entries: readonly BookingSettingAuditEntry[]; nextAfterVersion?: number }>;
export type KnowledgeReadFailure = Readonly<{ kind: "invalidQuery" | "unavailable" }>;

export interface KnowledgeHost {
  readKnowledge(scope: LocationScope, sourceRefs: readonly string[], signal?: AbortSignal): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>>;
}

/** Candidate facts for a transient model request; every answer is read again through KnowledgeHost. */
export interface ModelKnowledgeContextHost {
  listModelKnowledge(scope: LocationScope, now: string): Promise<Result<readonly ApprovedKnowledge[], KnowledgeReadFailure>>;
}

export interface AvailabilityHost {
  list(scope: LocationScope, from: string, to: string): Promise<Result<AvailabilityRead, AvailabilityReadFailure>>;
}

export interface AppointmentHost {
  list(scope: LocationScope, verificationRef: string, from: string, to: string, now: string): Promise<Result<AppointmentRead, AppointmentReadFailure>>;
}

export interface BookingEvidenceHost {
  resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>>;
}

/** The host issues this proof after its own caller verification; a provider ID is never proof. */
export interface PatientProofHost {
  verifyPatient(scope: LocationScope, verificationRef: string, now: string): Promise<Result<VerifiedPatient, HostReadFailure>>;
}

export interface HostEffects {
  write(mutation: HostMutation, now: string, signal?: AbortSignal): Promise<HostWriteReceipt>;
  reconcile(mutation: HostMutation, signal?: AbortSignal): Promise<ReconcileObservation>;
  openTask(item: StaffItem, signal?: AbortSignal): Promise<StaffTaskReceipt>;
  reconcileTask(item: StaffItem, signal?: AbortSignal): Promise<StaffTaskObservation>;
}

export interface StaffLifecycleHost {
  advanceTask(change: StaffChange, signal?: AbortSignal): Promise<StaffChangeReceipt>;
  reconcileTaskChange(change: StaffChange, signal?: AbortSignal): Promise<StaffChangeObservation>;
}

export interface OperatorAlertHost {
  sendAlert(alert: OperatorAlert, signal?: AbortSignal): Promise<OperatorAlertReceipt>;
  reconcileAlert(alert: OperatorAlert, signal?: AbortSignal): Promise<OperatorAlertObservation>;
}

export interface PolicyStore {
  read(scope: LocationScope): Promise<Result<CallPolicy, PolicyFailure>>;
  changeAutomationEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listAutomationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AutomationSettingAuditPage, PolicyFailure>>;
  changeBookingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listBookingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<BookingSettingAuditPage, PolicyFailure>>;
}
