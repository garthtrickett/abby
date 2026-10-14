import type { ClinicIntakeAuditPage } from "./clinic-intake-setting.ts";
import type { ClinicPatientCorrectionAuditPage } from "./clinic-patient-correction-setting.ts";
import type { StaffedDestinationAuditPage, StaffedDestinationCatalogue } from "./staffed-destination.ts";
import type { ActionRequest, AfterHoursMode, ApprovedAfterHoursInfo, ApprovedGreeting, ApprovedStaffSchedule, ApprovedUrgentResponse, ApprovedKnowledge, AppointmentRead, AppointmentReadFailure, AvailabilityRead, AvailabilityReadFailure, BookableOffer, CallPolicy, HostMutation, HostWriteReceipt, LocationScope, OperatorAlert, OperatorAlertObservation, OperatorAlertReceipt, ReconcileObservation, Result, StaffChange, StaffChangeObservation, StaffChangeReceipt, StaffItem, StaffTaskObservation, StaffTaskReceipt, VerifiedPatient } from "./model.ts";
import type { ReadinessFailure } from "./readiness.ts";
import type { CallState, FinalCallerTurn } from "./model.ts";

export type HostReadFailure = Readonly<{ kind: "notFound" | "ambiguous" | "expired" | "unavailable"; target: "patient" | "offer" | "appointment" }> |
  Readonly<{ kind: "outsideHorizon"; target: "offer"; snapshot: import("./booking-horizon.ts").BookingHorizonRead }>;
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

export type BookingSearchWindow = import("./booking-search-window.ts").BookingSearchWindow;
export type BookingMenuReadQuery = BookingMenuQuery & Readonly<{ from: string; to: string; window?: BookingSearchWindow | null; preference?: import("./booking-search-preference.ts").BookingSearchPreference }>;
export type BookingMenuQuery = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  turnId: string; now: string; signal: AbortSignal }>;
export type ReschedulingMenuQuery = BookingMenuQuery & Readonly<{ stage: import("./rescheduling-menu.ts").ReschedulingMenuStage }>;
export type ReschedulingMenuReadQuery = ReschedulingMenuQuery & Readonly<{ from: string; to: string; window?: BookingSearchWindow | null; priorTurnId?: string;
  nextPractitioners?: true;
  /** Derived from the canceled SAM request, never a caller/model provider ID. */
  correctingAppointmentRef?: string }>;
export interface ReschedulingMenuHost {
  correctReschedulingMenu?(query: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>):
    Promise<Result<Readonly<{ verificationRef: string; targetRef: string; offerRef: string }>, HostReadFailure>>;
  reschedulingMenuAvailable(): boolean;
  readReschedulingMenu(query: ReschedulingMenuReadQuery):
    Promise<Result<import("./rescheduling-menu.ts").ReschedulingMenuRead, HostReadFailure>>;
  selectReschedulingMenu(query: ReschedulingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>):
    Promise<Result<Readonly<{ kind: "targetSelected"; snapshot: Exclude<import("./rescheduling-menu.ts").ReschedulingMenuRead, import("./rescheduling-menu.ts").ReschedulingPractitionerRead> }> |
      Readonly<{ kind: "practitionerSelected"; snapshot: import("./rescheduling-menu.ts").ReschedulingPractitionerRead }> |
      Readonly<{ kind: "actionSelection"; verificationRef: string; targetRef: string; offerRef: string }>, HostReadFailure>>;
}
export interface BookingMenuHost {
  /** A trusted correction to an unsent proposal. Re-read this exact previously
   * offered time; never accept a model/provider reference or reuse its old proof. */
  correctBookingMenu?(query: BookingMenuQuery & Readonly<{ menuTurnId: string; startsAt: string }>):
    Promise<Result<Readonly<{ verificationRef: string; offerRef: string }>, HostReadFailure>>;
  bookingMenuAvailable(): boolean;
  readBookingMenu(query: BookingMenuReadQuery):
    Promise<Result<import("./booking-menu.ts").BookingMenuRead, HostReadFailure>>;
  /** Private selection wiring; these references are never returned by an agent command. */
  selectBookingMenu(query: BookingMenuQuery & Readonly<{ menuTurnId: string; choice: 1 | 2 | 3 }>):
    Promise<Result<Readonly<{ verificationRef: string; offerRef: string }>, HostReadFailure>>;
}

export interface BookingEvidenceHost {
  resolveBooking(scope: LocationScope, verificationRef: string, offerRef: string, now: string, signal?: AbortSignal): Promise<Result<Extract<ActionRequest, { kind: "book" }>, HostReadFailure>>;
}

export type WorkflowQuery = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  operation: import("./model.ts").WorkflowOperation; signal: AbortSignal; replaceCanceledChange?: true; expectedConversationRevision?: number;
  serviceChoice?: import("./booking-service-choice.ts").BookingServiceChoice; forAnotherPerson?: true; classAttendance?: true; classSelectionRef?: string; turnId?: string }>;
/** Trusted workflow routing issues neither patient proof nor a clinical action. */
export interface WorkflowHost {
  completeWorkflowStart?(query: WorkflowQuery & Readonly<{ turnId: string; advanceTask?: true }>): Promise<boolean>;
  abandonWorkflowStart?(query: WorkflowQuery & Readonly<{ turnId: string }>): Promise<void>;
  startWorkflow(query: WorkflowQuery): Promise<Result<Readonly<{ kind: "codeRequired" | "intakeRequired" | "representativeRequired"; advanceTask?: true }>, Readonly<{ kind: "workflowUnavailable" }>>>;
}

export type AppointmentEnquiryQuery = Omit<WorkflowQuery, "operation" | "replaceCanceledChange"> & Readonly<{ now: string }>;
export interface PreviousPractitionerHost {
  readPreviousPractitioner(query: AppointmentEnquiryQuery & Readonly<{ turnId: string }>): Promise<Result<
    Readonly<{ kind: "codeRequired" }> | Readonly<{ kind: "history"; snapshot: import("./previous-practitioner.ts").PreviousPractitionerRead }>, Readonly<{ kind: "historyUnavailable" }>>>;
}
/** An operation-bound read owner resolves its private proof. Caller/model commands never supply it. */
export interface AppointmentEnquiryHost {
  readAppointmentEnquiry(query: AppointmentEnquiryQuery & Readonly<{ from: string; to: string }>): Promise<Result<Readonly<{
    snapshot: AppointmentRead; checkedAt: string }>, AppointmentReadFailure>>;
  selectAppointmentEnquiry(query: AppointmentEnquiryQuery & Readonly<{ choice: 1 | 2 | 3 }>): Promise<Result<Readonly<{
    snapshot: AppointmentRead; from: string; to: string; checkedAt: string }>, AppointmentReadFailure>>;
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
  resolveAppointmentChange(query: AppointmentChangeEvidenceQuery, signal?: AbortSignal): Promise<Result<Extract<ActionRequest,
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

export type PatientCorrectionEvidenceQuery = Omit<IntakeEvidenceQuery, "draftRef"> & Readonly<{ correctionRef: string }>;
export interface PatientCorrectionEvidenceHost {
  /** Resolve privately collected/read-back details, consent and current patient authority. */
  resolvePatientCorrection(query: PatientCorrectionEvidenceQuery): Promise<Result<Extract<ActionRequest, { kind: "patientUpdate" }>, HostReadFailure>>;
}
export type ConfirmationResendEvidenceQuery = Omit<IntakeEvidenceQuery, "draftRef"> & Readonly<{ requestRef: string }>;
export interface ConfirmationResendEvidenceHost {
  resolveConfirmationResend(query: ConfirmationResendEvidenceQuery): Promise<Result<Extract<ActionRequest, { kind: "confirmationResend" }>, HostReadFailure>>;
}

/** The host issues this proof after its own caller verification; a provider ID is never proof. */
export interface PatientProofHost {
  verifyPatient(scope: LocationScope, verificationRef: string, now: string, signal?: AbortSignal): Promise<Result<VerifiedPatient, HostReadFailure>>;
}

export type StaffRequestQuery = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  turnId: string; callerText: string; expectedConversationRevision: number; requestedPerson?: string;
  requestSubject?: import("./staff-request-subject.ts").StaffRequestSubject; signal: AbortSignal;
}>;
export type StaffRequestPreparation = Readonly<{ kind: "messageNotice"; notice: import("./staff-message-notice.ts").StaffMessageNotice }> | Readonly<{ kind: "existing" }> | Readonly<{ kind: "codeRequired"; messageDraft?: true; requestSubject?: import("./staff-request-subject.ts").StaffRequestSubject }> |
  Readonly<{ kind: "ready"; requestedPerson?: string; requestSubject?: import("./staff-request-subject.ts").StaffRequestSubject }>;
export type StaffReviewProcessQuery = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string; taskKey: string; expectedConversationRevision: number; signal: AbortSignal }>;
export interface StaffReviewProcessHost {
  readStaffReviewProcess(query: StaffReviewProcessQuery): Promise<Result<import("./staff-review-process.ts").StaffReviewProcess, Readonly<{ kind: "staffReviewUnavailable" }>>>;
}

export interface StaffRequestHost {
  prepareStaffRequest(query: StaffRequestQuery): Promise<Result<StaffRequestPreparation, Readonly<{ kind: "staffUnavailable" }>>>;
  /** Transient draft owners may retain content across an accepted literal pause; this grants no send permission. */
  conversationControlAccepted?(turn: FinalCallerTurn, state: CallState): void;
}

export interface HostEffects {
  /** Trusted adapter budget for its complete effect protocol, including review
   * and readback. Dispatcher validates 1..120000 ms; absent means 15000 ms.
   * This is not caller/model input and cannot extend proof or call lifetimes. */
  readonly effectDeadlineMs?: number;
  write(mutation: HostMutation, now: string, signal?: AbortSignal): Promise<HostWriteReceipt>;
  reconcile(mutation: HostMutation, signal?: AbortSignal): Promise<ReconcileObservation>;
  openTask(item: StaffItem, signal?: AbortSignal): Promise<StaffTaskReceipt>;
  reconcileTask(item: StaffItem, signal?: AbortSignal): Promise<StaffTaskObservation>;
}

/** Both owners use a keyed host-approved delivery contract; implementations honor the captured owner/version. */
export interface NotificationHost {
  dispatchNotification(intent: import("./notification-effects.ts").NotificationIntent, signal?: AbortSignal):
    Promise<import("./notification-effects.ts").NotificationObservation>;
  observeNotification(intent: import("./notification-effects.ts").NotificationIntent, signal?: AbortSignal):
    Promise<import("./notification-effects.ts").NotificationObservation>;
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
  listVoiceOptions(scope: LocationScope): Promise<Result<import("./voice-profile.ts").VoiceCatalogue, PolicyFailure>>;
  changeVoiceSetting(scope: LocationScope, expectedVersion: string, kind: import("./voice-profile.ts").VoiceSettingKind,
    value: string | null, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listVoiceChanges(scope: LocationScope, afterVersion?: number):
    Promise<Result<import("./clinic-voice-setting.ts").VoiceSettingAuditPage, PolicyFailure>>;
  listNotificationOptions(scope: LocationScope): Promise<Result<import("./notification-policy.ts").NotificationCatalogue, PolicyFailure>>;
  changeNotificationOwner(scope: LocationScope, expectedVersion: string,
    kind: import("./notification-policy.ts").NotificationKind, owner: import("./notification-policy.ts").NotificationOwner | null,
    actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listNotificationChanges(scope: LocationScope, afterVersion?: number):
    Promise<Result<import("./notification-policy.ts").NotificationAuditPage, PolicyFailure>>;
  listStaffedDestinations(scope: LocationScope): Promise<Result<StaffedDestinationCatalogue, PolicyFailure>>;
  changeStaffedDestination(scope: LocationScope, expectedVersion: string, destinationRef: string | null,
                          actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listStaffedDestinationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<StaffedDestinationAuditPage, PolicyFailure>>;
  changeAutomationEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean, actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listAutomationChanges(scope: LocationScope, afterVersion?: number): Promise<Result<AutomationSettingAuditPage, PolicyFailure>>;
  changeFirstTimeIntakeEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean,
                              actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listFirstTimeIntakeChanges(scope: LocationScope, afterVersion?: number): Promise<Result<ClinicIntakeAuditPage, PolicyFailure>>;
  changePatientCorrectionsEnabled(scope: LocationScope, expectedVersion: string, enabled: boolean,
                                 actorRef: string): Promise<Result<CallPolicy, PolicyFailure>>;
  listPatientCorrectionChanges(scope: LocationScope, afterVersion?: number): Promise<Result<ClinicPatientCorrectionAuditPage, PolicyFailure>>;
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

/** Negative authority only: release all patient owners after SAM records the denial. */
export type CallerIdentityHost = Readonly<{
  revokeCallerPatientAccess(query: Readonly<{ scope: LocationScope; callId: string; sessionId: string;
    reason: import("./caller-identity.ts").CallerIdentityDenial }>): Promise<boolean>;
}>;

/** Cancel only unsent patient selections after a negative public routing turn. */
export type RequestBoundaryHost = Readonly<{
  clearUnsupportedWorkflow(query: Readonly<{ scope: LocationScope; callId: string; sessionId: string; turnId: string;
    conversationRevision: number }>): Promise<boolean>;
}>;

export type BookingHorizonQuery = Readonly<{ scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  expectedConversationRevision: number; signal: AbortSignal }>;
export interface BookingHorizonHost {
  readBookingHorizon(query: BookingHorizonQuery): Promise<Result<import("./booking-horizon.ts").BookingHorizonRead, Readonly<{ kind: "bookingHorizonUnavailable" }>>>;
}
