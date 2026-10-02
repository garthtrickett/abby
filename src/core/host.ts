import type { ActionRequest, AfterHoursMode, ApprovedAfterHoursInfo, ApprovedGreeting, ApprovedStaffSchedule, ApprovedUrgentResponse, ApprovedKnowledge, AppointmentRead, AppointmentReadFailure, AvailabilityRead, AvailabilityReadFailure, BookableOffer, CallPolicy, HostMutation, HostWriteReceipt, LocationScope, OperatorAlert, OperatorAlertObservation, OperatorAlertReceipt, ReconcileObservation, Result, StaffChange, StaffChangeObservation, StaffChangeReceipt, StaffItem, StaffTaskObservation, StaffTaskReceipt, VerifiedPatient } from "./model.ts";
import type { ReadinessFailure } from "./readiness.ts";

export type HostReadFailure = Readonly<{ kind: "notFound" | "ambiguous" | "expired" | "unavailable"; target: "patient" | "offer" | "appointment" }>;
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
export type CancellationSettingAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  previousEnabled: boolean;
  actorRef: string;
  changedAt: string;
}>;
export type CancellationSettingAuditPage = Readonly<{
  entries: readonly CancellationSettingAuditEntry[];
  nextAfterVersion?: number;
}>;
export type ReschedulingSettingAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  previousEnabled: boolean;
  actorRef: string;
  changedAt: string;
}>;
export type ReschedulingSettingAuditPage = Readonly<{
  entries: readonly ReschedulingSettingAuditEntry[];
  nextAfterVersion?: number;
}>;
export type AfterHoursSettingAuditEntry = Readonly<{
  version: string;
  mode: AfterHoursMode;
  previousMode: AfterHoursMode;
  infoVersion?: string;
  actorRef: string;
  changedAt: string;
}>;
export type AfterHoursSettingAuditPage = Readonly<{
  entries: readonly AfterHoursSettingAuditEntry[];
  nextAfterVersion?: number;
}>;
export type UrgentSettingAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  previousEnabled: boolean;
  scriptVersion?: string;
  actorRef: string;
  changedAt: string;
}>;
export type UrgentSettingAuditPage = Readonly<{
  entries: readonly UrgentSettingAuditEntry[];
  nextAfterVersion?: number;
}>;
export type StaffScheduleSettingAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  previousEnabled: boolean;
  scheduleVersion?: string;
  actorRef: string;
  changedAt: string;
}>;
export type StaffScheduleSettingAuditPage = Readonly<{
  entries: readonly StaffScheduleSettingAuditEntry[];
  nextAfterVersion?: number;
}>;
export type GreetingSettingAuditEntry = Readonly<{
  version: string;
  enabled: boolean;
  previousEnabled: boolean;
  greetingVersion?: string;
  actorRef: string;
  changedAt: string;
}>;
export type GreetingSettingAuditPage = Readonly<{
  entries: readonly GreetingSettingAuditEntry[];
  nextAfterVersion?: number;
}>;
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
  /** Optional one-time choice from a previously spoken list; the host rechecks the exact appointment. */
  select?(scope: LocationScope, verificationRef: string, choice: 1 | 2 | 3, now: string): Promise<Result<Readonly<{
    snapshot: AppointmentRead; from: string; to: string;
  }>, AppointmentReadFailure>>;
}

export interface BookingEvidenceHost {
  resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>>;
}

/** Opaque selections and proof are resolved by the host; neither is a provider ID from the model. */
export type AppointmentChangeSelection = Readonly<{ verificationRef: string; targetRef: string }> &
  (Readonly<{ kind: "cancel" }> | Readonly<{ kind: "reschedule"; offerRef: string }>);
export type AppointmentChangeEvidenceQuery = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  now: string;
}> & AppointmentChangeSelection;
export interface AppointmentChangeEvidenceHost {
  resolveAppointmentChange(query: AppointmentChangeEvidenceQuery): Promise<Result<Extract<ActionRequest,
    { kind: "cancel" | "reschedule" }>, HostReadFailure>>;
}

/** Only a trusted host may turn a call-scoped draft reference into approved intake evidence. */
export type IntakeEvidenceQuery = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  draftRef: string;
  now: string;
}>;
export interface IntakeEvidenceHost {
  resolveIntake(query: IntakeEvidenceQuery): Promise<Result<Extract<ActionRequest, { kind: "intake" }>, HostReadFailure>>;
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
  changeCancellationEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean,
                            actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listCancellationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<CancellationSettingAuditPage, PolicyFailure>>;
  changeReschedulingEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean,
                            actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listReschedulingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<ReschedulingSettingAuditPage, PolicyFailure>>;
  changeAfterHours(scope: LocationScope, expectedVersion: string, mode: AfterHoursMode,
                   info: ApprovedAfterHoursInfo | undefined, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listAfterHoursChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AfterHoursSettingAuditPage, PolicyFailure>>;
  changeUrgentResponse(scope: LocationScope, expectedVersion: string, response: ApprovedUrgentResponse | undefined,
                       actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listUrgentResponseChanges(scope: LocationScope, afterVersion?: number): Promise<Result<UrgentSettingAuditPage, PolicyFailure>>;
  changeStaffSchedule(scope: LocationScope, expectedVersion: string, schedule: ApprovedStaffSchedule | undefined,
                      actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listStaffScheduleChanges(scope: LocationScope, afterVersion?: number): Promise<Result<StaffScheduleSettingAuditPage, PolicyFailure>>;
  changeGreeting(scope: LocationScope, expectedVersion: string, greeting: ApprovedGreeting | undefined,
                 actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listGreetingChanges(scope: LocationScope, afterVersion?: number): Promise<Result<GreetingSettingAuditPage, PolicyFailure>>;
}
