export type Result<Value, Failure> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; error: Failure }>;

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });
export const err = <Failure>(error: Failure): Result<never, Failure> => ({ ok: false, error });

export type LocationScope = Readonly<{ tenantId: string; clinicId: string; locationId: string }>;
export type ProviderCallKey = Readonly<{ accountRef: string; providerCallRef: string }>;
export type Admission = Readonly<{
  key: ProviderCallKey;
  dialedNumber: string;
  acceptedAt: string;
  deadline: string;
}>;
export type SessionLease = Readonly<{ sessionId: string; version: number; expiresAt: string; validForMs: number }>;
export const CALL_TERMINAL_REASONS = ["callerDisconnected", "sessionClosed", "mediaFailure", "localLeaseClosed",
  "admissionExpired", "leaseExpired", "transferConnected", "transferUnproven", "textCompleted"] as const;
export type CallTerminalReason = typeof CALL_TERMINAL_REASONS[number];
export type CallTerminal = Readonly<{ reason: CallTerminalReason; at: string }>;
export type AdmissionReceipt = Readonly<{ callId: string; scope: LocationScope; admission: Admission; lifecycle: "starting" | "active" | "ended" }>;
export type AdmissionResult = Readonly<{ kind: "created" | "duplicate"; receipt: AdmissionReceipt }>;
export type PendingLocationRoute = Readonly<{
  candidateServices?: import("./location-services.ts").LocationServices;
  tenantId: string;
  clinicId: string;
  /** Captured before a shared-number prompt. Legacy stored routes without it grant no new voice authority. */
  voiceProfile?: import("./voice-profile.ts").VoiceProfile;
  candidateLocationIds: readonly string[];
  candidateNames: readonly Readonly<{ locationId: string; spokenName: string }>[];
  routeVersion: string;
}>;
export type PendingLocationPrompt = Readonly<{
  playbackId: string;
  sessionId: string;
  leaseVersion: number;
  status: "started" | "queued" | "played" | "failed" | "unproven" | "interrupted";
  startedAt: string;
  resolvedAt?: string;
}>;
export type PendingLocationCall = Readonly<{
  callId: string;
  route: PendingLocationRoute;
  admission: Admission;
  status: "pending" | "expired" | "bound";
  sessionLease?: SessionLease;
  prompt?: PendingLocationPrompt;
  closeEvidence?: Readonly<{ sessionId: string; leaseVersion: number; reason: "callerDisconnected" | "sessionClosed" | "mediaFailure"; at: string }>;
  choiceEvidence?: Readonly<{ sessionId: string; leaseVersion: number; turnId: string; selectedLocationId: string; at: string }>;
}>;
export type PendingLocationResult = Readonly<{ kind: "created" | "duplicate"; pending: PendingLocationCall }>;
export type PendingLocationExpiryResult = Readonly<{ kind: "expired" | "alreadyExpired" | "bound"; pending: PendingLocationCall }>;
export type ActiveSessionReceipt = Readonly<{ callId: string; scope: LocationScope; lease: SessionLease }>;
export type PendingPresentationRef = Readonly<{ callId: string; scope: LocationScope; sessionId: string; presentationId: string }>;
export const POSSIBLE_SEND_RECOVERY_DELAY_MS = 60_000;
export type StaffDestination =
  | Readonly<{ kind: "owner"; ownerRef: string }>
  | Readonly<{ kind: "queue"; queueRef: string }>;
export type ActionKind = "book" | "cancel" | "reschedule" | "intake" | "patientUpdate" | "confirmationResend";
/** Routing to patient information is not a clinical mutation capability. */
export type WorkflowOperation = ActionKind | "appointments.read";
export type CapabilityId = ActionKind | "transfer";
export type CapabilityMode = "execute" | "requestOnly" | "unavailable";

/** Host permissions are independent of saved clinic toggles. */
export type AppointmentSettingModes = Readonly<{ cancellation?: CapabilityMode; rescheduling?: CapabilityMode }>;
export type PatientSettingModes = AppointmentSettingModes & Readonly<{ intake?: CapabilityMode; patientUpdate?: CapabilityMode }>;
export type StaffedInterval = Readonly<{ startsAt: string; endsAt: string }>;
/** Sunday is 0; endMinute before startMinute crosses midnight. */
export type LocalStaffWindow = Readonly<{ weekday: number; startMinute: number; endMinute: number }>;
export type LocalStaffSchedule = Readonly<{
  timeZone: string;
  weekly: readonly LocalStaffWindow[];
  closedDates: readonly string[];
}>;
export type ApprovedStaffSchedule = LocalStaffSchedule & Readonly<{
  scope: LocationScope;
  version: string;
  ownerRef: string;
  approved: true;
  effectiveFrom: string;
  effectiveUntil: string;
}>;
export type ApprovedGreeting = Readonly<{
  scope: LocationScope;
  version: string;
  ownerRef: string;
  approvedText: string;
  approved: true;
  /** New clinic-admin approvals are time bounded; absent only on legacy host-provided greetings. */
  effectiveFrom?: string;
  effectiveUntil?: string;
}>;
export type AfterHoursMode = "staffRequest" | "approvedInfoAndRequest";
export type ApprovedAfterHoursInfo = Readonly<{
  scope: LocationScope;
  version: string;
  ownerRef: string;
  approvedText: string;
  approved: true;
}>;
export type ApprovedUrgentResponse = Readonly<{
  scope: LocationScope;
  version: string;
  ownerRef: string;
  approvedText: string;
  approved: true;
  effectiveFrom: string;
  effectiveUntil: string;
}>;

export type CallPolicy = Readonly<{
  scope: LocationScope;
  policyVersion: string;
  automationVersion: string;
  automationEnabled: boolean;
  bookingEnabled: boolean;
  /** Absent on legacy snapshots; policy-store default is false. */
  cancellationEnabled?: boolean;
  /** Absent on legacy snapshots; policy-store default is false. */
  reschedulingEnabled?: boolean;
  /** Clinic-wide; absent legacy snapshots are disabled at version 0. */
  firstTimeIntakeEnabled?: boolean;
  firstTimeIntakeVersion?: string;
  /** Independent clinic-wide preference; legacy snapshots are disabled at version 0. */
  patientCorrectionsEnabled?: boolean;
  patientCorrectionsVersion?: string;
  /** Clinic preferences are public configuration; they are not host send authority. */
  notificationSettings?: import("./notification-policy.ts").NotificationSettings;
  /** Current scoped host declarations captured at admission; absent means no managed delivery. */
  notificationBindings?: Readonly<Partial<Record<import("./notification-policy.ts").NotificationKind,
    import("./notification-policy.ts").NotificationBinding>>>;
  /** Shared clinic preferences are public configuration, never speech authority. */
  voiceSettings?: import("./voice-profile.ts").VoicePreferences;
  /** Host-approved profile captured for this call; absent means voice is not ready. */
  voiceProfile?: import("./voice-profile.ts").VoiceProfile;
  /** Absent on legacy snapshots; the effective default is staffRequest. */
  afterHoursMode?: AfterHoursMode;
  afterHoursInfo?: ApprovedAfterHoursInfo;
  /** Host-approved, location-scoped public safety wording; absent means generic fallback. */
  urgentResponse?: ApprovedUrgentResponse;
  /** Existing hosts omit patientUpdate; absence denies the new operation. */
  capabilities: Readonly<Record<Exclude<CapabilityId, "patientUpdate" | "confirmationResend">, CapabilityMode> & { patientUpdate?: CapabilityMode; confirmationResend?: CapabilityMode }>;
  /** Current independently approved host binding, never a patient/message digest. */
  confirmationResendVersion?: string;
  transferDestinationRef?: string;
  /** Current host route declaration captured at admission, never setting authority. */
  transferDestinationVersion?: string;
  /** Approved local schedule expanded at voice admission, never trusted as pre-expanded evidence. */
  staffSchedule?: ApprovedStaffSchedule;
  /** UTC horizon over which staffedIntervals is a complete clinic-approved snapshot. */
  staffedCoverage?: StaffedInterval;
  staffedIntervals?: readonly StaffedInterval[];
  staffDestination: StaffDestination;
  operatorQueue: StaffDestination;
  /** Host-owned staff work is proven for this call; false blocks all task intents. */
  staffWorkEnabled?: boolean;
  /** Required for voice admission; optional for legacy and text-only snapshots. */
  greeting?: ApprovedGreeting;
  numberRouteVersion?: string;
  /** Source versions captured for this call; absent only on legacy or host-owned snapshots. */
  knowledgeSnapshot?: readonly Readonly<{ sourceRef: string; version: string }>[];
}>;

export type VerifiedPatient = Readonly<{
  scope: LocationScope;
  patientRef: string;
  verificationRef: string;
  expiresAt: string;
}>;
export type BookableOffer = Readonly<{
  /** Optional host-approved booking terms share the exact offer expiry and action digest. */
  terms?: AppointmentChangeTerms;
  scope: LocationScope;
  offerRef: string;
  serviceRef: string;
  presentation?: Readonly<{ timeZone: string; practitionerName: string; appointmentTypeName: string; locationName?: string; durationMinutes: number }>;
  startsAt: string;
  expiresAt: string;
}>;
export type AppointmentTarget = Readonly<{
  scope: LocationScope;
  appointmentRef: string;
  patientRef: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
}>;

/** Host-approved wording is bound to the confirmed action digest and rechecked at commit. */
export type AppointmentChangeTerms = Readonly<{
  version: string;
  approvedText: string;
  expiresAt: string;
}>;

export type ActionRequest =
  | Readonly<{ kind: "book"; patient: VerifiedPatient; offer: BookableOffer }>
  | Readonly<{ kind: "cancel"; patient: VerifiedPatient; target: AppointmentTarget; terms: AppointmentChangeTerms }>
  | Readonly<{ kind: "reschedule"; patient: VerifiedPatient; target: AppointmentTarget; offer: BookableOffer; terms: AppointmentChangeTerms; practitionerChange?: true; serviceChange?: Readonly<{ fromServiceName: string }> }>
  | Readonly<{ kind: "intake"; scope: LocationScope; approvedDraftRef: string; consentRef: string; duplicateCheckRef: string; recoveryContract?: "callerMediated" }>
  /** Patient values and value digests remain in the private owner, never in SAM. */
  | Readonly<{ kind: "patientUpdate"; patient: VerifiedPatient; correctionRef: string; consentRef: string; correctionVersion: string; expiresAt: string }>
  | Readonly<{ kind: "confirmationResend"; scope: LocationScope; requestRef: string; resendVersion: string; expiresAt: string }>;

export type FinalCallerTurn = Readonly<{
  callId: string;
  sessionId?: string;
  turnId: string;
  text: string;
  quality: "clear" | "needsClarification";
  at: string;
}>;

export type ApprovedKnowledge = Readonly<{
  scope: LocationScope;
  sourceRef: string;
  version: string;
  ownerRef: string;
  approvedText: string;
  approved: boolean;
  effectiveFrom: string;
  effectiveUntil: string;
}>;

export type AvailabilitySnapshot = Readonly<{
  kind: "times";
  scope: LocationScope;
  sourceRef: string;
  timeZone: string;
  observedAt: string;
  startsAt: readonly string[];
  reservable: false;
  /** Current provider metadata, required when an approved fallback choice supplies a time. */
  offering?: Readonly<{ practitionerName: string; appointmentTypeName: string }>;
}>;
export type AvailabilityRead = AvailabilitySnapshot | Readonly<{ kind: "notEligible"; reason: "business" | "practitioner" | "appointmentType" }>;
export type AvailabilityReadFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidRange" | "forbidden" | "notFound" | "rateLimited" | "unavailable" | "malformed" | "tooManyResults";
  resetAt?: string;
}>;

export type AppointmentReadFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidProof" | "invalidRange" | "notFound" | "forbidden" | "rateLimited" |
    "unavailable" | "malformed" | "tooManyResults";
  resetAt?: string;
}>;
export type AppointmentRead = Readonly<{
  scope: LocationScope;
  sourceRef: string;
  observedAt: string;
  timeZone: string;
  patientRef: string;
  verificationRef: string;
  proofExpiresAt: string;
  appointments: readonly Readonly<{ appointmentRef: string; startsAt: string; endsAt: string }>[];
}>;

export type MenuClarificationReason = "menuAmbiguous" | "menuRejected" | "menuUnavailable" | "proposalCorrection" |
  "changeAmbiguous" | "targetDisagreement" | "changeUnsupported" | "serviceChoiceChanged" | "serviceSelectionUnavailable" | "changeAfterSend" | "oldAppointmentAfterMove" | "searchPreferenceUnavailable" | "clinicalAdviceUnavailable" | "unattendedAnnouncement" |
  "paymentEvidenceUnavailable" | "coverageEvidenceUnavailable" | "refundEvidenceUnavailable" | "reservationEvidenceUnavailable" | "arrivalAccessUnavailable" | "publicFactConflict" | "serviceArrangementUnavailable";
export type TurnInterpretation =
  | Readonly<{ kind: "previousPractitioner"; snapshot: import("./previous-practitioner.ts").PreviousPractitionerRead }>
  | Readonly<{ kind: "previousPractitionerUnavailable" }>
  | Readonly<{ kind: "serviceQuestion"; question: import("./booking-service-question.ts").BookingServiceQuestion }>
  | Readonly<{ kind: "classServiceQuestion"; question: import("./class-service-question.ts").ClassServiceQuestion }>
  | Readonly<{ kind: "conversationControl"; notice: import("./conversation-control.ts").ConversationControlNotice }>
  | Readonly<{ kind: "conversationPresence" }>
  | Readonly<{ kind: "missedCallReasonUnavailable" }>
  | Readonly<{ kind: "bookingHorizon"; snapshot: import("./booking-horizon.ts").BookingHorizonRead }>
  | Readonly<{ kind: "bookingHorizonFailure" }>
  | Readonly<{ kind: "requestBoundary"; reason: import("./request-boundary.ts").RequestBoundary }>
  | Readonly<{ kind: "callerIdentityDenied"; reason: import("./caller-identity.ts").CallerIdentityDenial }>
  | Readonly<{ kind: "workflowStarted"; operation: WorkflowOperation; next: "codeRequired" | "intakeRequired" | "representativeRequired"; advanceTask?: true }>
  | Readonly<{ kind: "outcomeQuery" }>
  | Readonly<{ kind: "notificationOutcomeQuery" }>
  | Readonly<{ kind: "staffOutcomeQuery"; reviewProcess?: import("./staff-review-process.ts").StaffReviewProcess }>
  | Readonly<{ kind: "staffVerificationRequired"; messageDraft?: true; requestSubject?: import("./staff-request-subject.ts").StaffRequestSubject }>
  | Readonly<{ kind: "staffUnavailable"; requestSubject?: import("./staff-request-subject.ts").StaffRequestSubject }>
  | Readonly<{ kind: "staffMessageNotice"; notice: import("./staff-message-notice.ts").StaffMessageNotice }>
  | Readonly<{ kind: "staffRequestReady"; requestedPerson?: string; requestSubject?: import("./staff-request-subject.ts").StaffRequestSubject }>
  | Readonly<{ kind: "modelPending"; taskRef: string }>
  | Readonly<{ kind: "modelFallback"; staffWorkUnavailable?: true }>
  | Readonly<{ kind: "clarify"; reason?: MenuClarificationReason; approvedLocation?: string }>
  | Readonly<{ kind: "requestAction"; request: ActionRequest }>
  | Readonly<{ kind: "affirm"; actionKey: string; digest: string; affirmative: boolean }>
  | Readonly<{ kind: "classMovementAffirm"; actionKey: string; digest: string }>
  | Readonly<{ kind: "confirmationWait"; actionKey: string; digest: string; seconds: number }>
  | Readonly<{ kind: "handoff"; reason: StaffReason; requestedPerson?: string; staffWorkUnavailable?: true }>
  | Readonly<{ kind: "transfer"; reason: StaffReason }>
  | Readonly<{ kind: "readFailure"; target: "patient" | "offer" | "appointment"; failure: "unavailable" | "notFound" }>
  | Readonly<{ kind: "intakeFailure"; reason: "missing" | "unavailable" }>
  | Readonly<{ kind: "unavailableAction"; actionKind: ActionKind }>
  | Readonly<{ kind: "answer"; sources: readonly ApprovedKnowledge[]; proposedText: string; publicTopic?: import("./public-information.ts").PublicInformationTopic }>
  | Readonly<{ kind: "knowledgeFailure"; reason: "invalidQuery" | "unavailable"; publicTopic?: import("./public-information.ts").PublicInformationTopic }>
  | Readonly<{ kind: "availability"; from: string; to: string; snapshot: AvailabilitySnapshot }>
  | Readonly<{ kind: "availabilityFailure"; reason: AvailabilityReadFailure["kind"] | "notEligible" | "notConfigured" | "unclear" }>
  | Readonly<{ kind: "appointments"; from: string; to: string; snapshot: AppointmentRead; declareRange?: true }>
  | Readonly<{ kind: "appointmentsFailure"; reason: AppointmentReadFailure["kind"] | "notConfigured" | "unclear" }>
  | Readonly<{ kind: "bookingMenu"; snapshot: import("./booking-menu.ts").BookingMenuRead }>
  | Readonly<{ kind: "bookingMenuFailure" }>
  | Readonly<{ kind: "reschedulingMenu"; snapshot: import("./rescheduling-menu.ts").ReschedulingMenuRead }>
  | Readonly<{ kind: "reschedulingMenuFailure" }>
  | Readonly<{ kind: "ambiguousTarget" }>;

export const STAFF_REASONS = ["callerRequested", "verificationFailed", "unsupported", "uncertainAction",
  "partialIntake", "systemFailure", "transferFailed", "emergencyStopped", "potentiallyUrgent"] as const;
export type StaffReason = typeof STAFF_REASONS[number];
export type ActionStatus =
  | "awaitingConfirmation" | "ready" | "dispatched" | "committed"
  | "rejected" | "unsupported" | "uncertain" | "needsReview" | "canceled" | "pendingContinuation";
export type HostMutation = Readonly<{
  kind: ActionKind;
  scope: LocationScope;
  actionKey: string;
  payloadDigest: string;
  policyVersion: string;
  request: ActionRequest;
  /** Host must suppress native notification sends and acknowledge this exact captured directive. */
  notification?: import("./notification-effects.ts").NotificationDirective;
}>;
export type ActionState = Readonly<{
  key: string;
  kind: ActionKind;
  status: ActionStatus;
  digest: string;
  mutation: HostMutation;
  presentationId: string;
  hostRef?: string;
  reconciliationDeadline?: string;
  /** Fixed progress and an opaque live-stage reference; neither reconstructs
   * a private sender or grants permission for another operation. */
  classMovement?: import("./class-movement-continuation.ts").ClassMovementState;
  classMovementConsent?: import("./class-movement-consent.ts").ClassMovementConsent & Readonly<{ presentationId: string; playedAt?: string }>;
}>;
export type Presentation =
  | Readonly<{
    kind: "speech";
    id: string;
    actionKey: string;
    digest: string;
    approvedText: string;
    status: "pending" | "started" | "played" | "interrupted" | "failed" | "unproven" | "superseded";
  }>
  | Readonly<{
    kind: "notice";
    id: string;
    approvedText: string;
    /** Only a core-validated confirmation wait can extend this notice's listening interval. */
    confirmationWaitSeconds?: number;
    status: "pending" | "started" | "played" | "interrupted" | "failed" | "unproven" | "superseded";
  }>
  | Readonly<{
    kind: "transfer";
    id: string;
    destinationRef: string;
    reason: StaffReason;
    status: "pending" | "started" | "possiblySent" | "connected" | "failed" | "unproven" | "canceled" | "superseded";
    providerConnectionRef?: string;
  }>;
export type HostWriteReceipt =
  | import("./class-movement-continuation.ts").ClassMovementReceipt
  | Readonly<{ kind: "committed"; actionKey: string; hostRef: string;
    notification?: import("./notification-effects.ts").NotificationDirective }>
  | Readonly<{ kind: "rejected"; actionKey: string; reason: "conflict" | "invalid" | "forbidden" | "expiredOffer" }>
  | Readonly<{ kind: "unsupported"; actionKey: string }>
  | Readonly<{ kind: "uncertain"; actionKey: string; reconcileAfter: string; deadline: string }>;
export type ReconcileObservation =
  | Readonly<{ kind: "exactCommit"; actionKey: string; hostRef: string;
    notification?: import("./notification-effects.ts").NotificationDirective }>
  | Readonly<{ kind: "definitiveNonCommit"; actionKey: string }>
  | Readonly<{ kind: "stillUnknown"; actionKey: string }>;
export type StaffTaskReceipt =
  | Readonly<{ kind: "opened"; taskKey: string; hostTaskRef: string; destination: StaffDestination; reviewProcess?: import("./staff-review-process.ts").StaffReviewProcess }>
  | Readonly<{ kind: "rejected"; taskKey: string }>
  | Readonly<{ kind: "uncertain"; taskKey: string }>;
export type StaffTaskObservation =
  | Readonly<{ kind: "exactOpen"; taskKey: string; hostTaskRef: string; destination: StaffDestination }>
  | Readonly<{ kind: "definitiveNonOpen"; taskKey: string }>
  | Readonly<{ kind: "stillUnknown"; taskKey: string }>;
export type StaffChangeOperation = "acknowledge" | "resolve" | "reassign";
export type StaffChangeRequest =
  | Readonly<{ kind: "acknowledge" | "resolve" }>
  | Readonly<{ kind: "reassign"; target: "staff" | "operator" }>;
export type StaffChange = Readonly<{
  commandKey: string;
  taskKey: string;
  scope: LocationScope;
  hostTaskRef: string;
  actorRef: string;
  operation: StaffChangeOperation;
  fromStatus: "open" | "acknowledged";
  fromDestination: StaffDestination;
  toDestination: StaffDestination;
}>;
export type StaffChangeReceipt =
  | Readonly<{ kind: "applied"; commandKey: string; taskKey: string; hostTaskRef: string; status: "open" | "acknowledged" | "resolved"; destination: StaffDestination }>
  | Readonly<{ kind: "rejected" | "uncertain"; commandKey: string; taskKey: string }>;
export type StaffChangeObservation =
  | Readonly<{ kind: "exactApplied"; commandKey: string; taskKey: string; hostTaskRef: string; status: "open" | "acknowledged" | "resolved"; destination: StaffDestination }>
  | Readonly<{ kind: "definitiveNonApplied" | "stillUnknown"; commandKey: string; taskKey: string }>;
export type StaffAlertReason = "overdue" | "needsReview";
export type StaffAlertState = "pending" | "delivered" | "uncertain" | "failed" | "canceled";
export type OperatorAlert = Readonly<{
  alertKey: string;
  callId: string;
  taskKey: string;
  scope: LocationScope;
  reason: StaffAlertReason;
  destination: StaffDestination;
  dueAt: string;
}>;
export type OperatorAlertReceipt = Readonly<{ kind: "delivered" | "failed" | "uncertain"; alertKey: string }>;
export type OperatorAlertObservation = Readonly<{ kind: "exactDelivered" | "definitiveNotDelivered" | "stillUnknown"; alertKey: string }>;
export type StaffItem = Readonly<{
  requestedPerson?: string;
  requestSubject?: import("./staff-request-subject.ts").StaffRequestSubject;
  key: string;
  scope: LocationScope;
  reason: StaffReason;
  destination: StaffDestination;
  dueAt: string;
  status: "requested" | "open" | "acknowledged" | "resolved" | "needsReview" | "failed";
  linkedActionKey?: string;
  request?: ActionRequest;
  hostTaskRef?: string;
  pendingChangeKey?: string;
  reviewRequired?: boolean;
  alerts?: Partial<Record<StaffAlertReason, StaffAlertState>>;
}>;
export type StaffQueueEntry = Readonly<{
  callId: string;
  callVersion: number;
  taskKey: string;
  reason: StaffReason;
  status: StaffItem["status"];
  dueAt: string;
  destination: StaffDestination;
  linkedActionKey?: string;
  pendingChangeKey?: string;
  reviewRequired?: boolean;
  alerts?: Partial<Record<StaffAlertReason, StaffAlertState>>;
}>;
export type Effect =
  | Readonly<{ kind: "model"; schemaVersion: 1; id: string; taskRef: string; turnId: string; conversationRevision: number; status: "pending" | "completed" | "canceled" }>
  | Readonly<{ kind: "modelKnowledge"; schemaVersion: 1; id: string; taskRef: string; turnId: string; conversationRevision: number;
      sourceRefsDigest: string; status: "pending" | "completed" | "canceled" }>
  | Readonly<{ kind: "hostWrite"; id: string; actionKey: string; mutation: HostMutation;
      classMovementConsent?: import("./class-movement-consent.ts").ClassMovementConsent;
      status: "pending" | "possiblySent" | "completed" | "uncertain" | "canceled"; possiblySentAt?: string }>
  | Readonly<{ kind: "hostReconcile"; id: string; actionKey: string; originalEffectId: string; status: "pending" | "completed" }>
  | Readonly<{ kind: "staffTask"; id: string; taskKey: string; status: "pending" | "possiblySent" | "completed" | "uncertain"; possiblySentAt?: string }>
  | Readonly<{ kind: "staffReconcile"; id: string; taskKey: string; originalEffectId: string; originalItem: StaffItem; status: "pending" | "completed" }>
  | Readonly<{ kind: "staffChange"; id: string; taskKey: string; change: StaffChange; status: "pending" | "possiblySent" | "completed" | "uncertain"; possiblySentAt?: string }>
  | Readonly<{ kind: "staffChangeReconcile"; id: string; taskKey: string; originalEffectId: string; change: StaffChange; status: "pending" | "completed" }>
  | Readonly<{ kind: "operatorAlert"; id: string; alert: OperatorAlert; status: "pending" | "possiblySent" | "completed" | "uncertain" | "canceled"; possiblySentAt?: string }>
  | Readonly<{ kind: "operatorAlertReconcile"; id: string; alert: OperatorAlert; originalEffectId: string; status: "pending" | "completed" }>
  | import("./notification-effects.ts").NotificationEffect;
export type RecoverableEffectRef = Readonly<{
  callId: string;
  scope: LocationScope;
  effectId: string;
  kind: Effect["kind"];
  status: "pending" | "possiblySent";
}>;

export type CallState = {
  /** Call-scoped denial; standalone clinical calls keep this state transiently. */
  callerIdentityDenied?: import("./caller-identity.ts").CallerIdentityDenial;
  /** Negative-command receipt only; no patient identity or permission. */
  lastRequestBoundary?: Readonly<{ turnId: string; reason: import("./request-boundary.ts").RequestBoundary }>;
  /** Accepted workflow receipt only; contains no patient identity or permission. */
  lastWorkflowStart?: Readonly<{ turnId: string; operation: WorkflowOperation; next: "codeRequired" | "intakeRequired" | "representativeRequired" }>;
  callId: string;
  policy: CallPolicy;
  lifecycle: "starting" | "active" | "ended";
  terminal?: CallTerminal;
  admission?: Admission;
  sessionLease?: SessionLease;
  version: number;
  conversationRevision: number;
  processedTurnIds: string[];
  actions: Record<string, ActionState>;
  /** Settled prior-task action keys remain in actions; current-task outcome queries exclude them. */
  previousTaskActionKeys?: readonly string[];
  presentations: Record<string, Presentation>;
  pendingPresentationId?: string;
  effects: Record<string, Effect>;
  staffItems: Record<string, StaffItem>;
  callerMessages: string[];
  knowledgeAnswers: Array<Readonly<{ turnId: string; sourceRef: string; version: string; ownerRef: string }>>;
  availabilityReads: Array<Readonly<{
    turnId: string;
    status: "shown" | "empty" | "failed";
    sourceRef?: string;
    timeZone?: string;
    observedAt?: string;
    shownStartsAt?: readonly string[];
    reason?: string;
  }>>;
  appointmentReads: Array<Readonly<{
    turnId: string;
    status: "shown" | "empty" | "failed";
    sourceRef?: string;
    shownCount?: number;
    reason?: string;
  }>>;
};

export type TransitionFailure =
  | Readonly<{ kind: "callUnknown" | "callConflict" | "versionConflict" | "invalidTransition" | "scopeMismatch" | "evidenceExpired" | "confirmationMissing" | "digestChanged" | "effectUnknown" | "keyMismatch" | "storageFailure" | "storageCorrupt" | "admissionExpired" | "leaseLost" | "staleTurn" }>;

export type TransitionAction =
  | import("./notification-effects.ts").NotificationTransitionAction
  | Readonly<{ kind: "sessionActivated"; sessionId: string; now: string }>
  | Readonly<{ kind: "sessionRenewed"; sessionId: string; expectedLeaseVersion: number; now: string }>
  | Readonly<{ kind: "admissionExpired"; now: string }>
  | Readonly<{ kind: "sessionExpired"; sessionId: string; expectedLeaseVersion: number; now: string }>
  | Readonly<{ kind: "callEnded"; sessionId: string; reason: "callerDisconnected" | "sessionClosed" | "mediaFailure" | "localLeaseClosed"; now: string }>
  | Readonly<{ kind: "textPresentationWritten"; presentationId: string; now: string }>
  | Readonly<{ kind: "speechBegan"; sessionId: string; now: string }>
  | Readonly<{ kind: "nonAffirmativeFinal"; turn: FinalCallerTurn; expectedConversationRevision: number; now: string }>
  | Readonly<{ kind: "silenceTimeout"; sessionId: string; stage: "retry" | "final"; now: string }>
  | Readonly<{ kind: "privateIntakePrompt"; sessionId: string; presentationId: string; now: string }>
  | Readonly<{ kind: "privateCorrectionPrompt"; sessionId: string; presentationId: string; now: string }>
  | Readonly<{ kind: "privateResendPrompt"; sessionId: string; presentationId: string; now: string }>
  | Readonly<{ kind: "privateRepresentativePrompt"; operation: "book" | "cancel" | "reschedule" | "appointments.read"; sessionId: string; presentationId: string; now: string }>
  | Readonly<{ kind: "callerTurn"; turn: FinalCallerTurn; interpretation: TurnInterpretation; now: string; expectedConversationRevision?: number }>
  | Readonly<{ kind: "modelResolved"; effectId: string; result: Result<import("../model/proposal.ts").ModelProposal, import("../model/proposal.ts").ModelFailure>; now: string }>
  | Readonly<{ kind: "modelKnowledgeResolved"; effectId: string; result: Result<readonly ApprovedKnowledge[], Readonly<{ kind: "invalidQuery" | "unavailable" }>>;
      proposedText?: string; now: string }>
  | Readonly<{ kind: "presentationStarted"; presentationId: string; sessionId?: string; now?: string }>
  | Readonly<{ kind: "transferPossiblySent"; presentationId: string; sessionId: string; now: string }>
  | Readonly<{ kind: "presentationResolved"; presentationId: string; status: "played" | "interrupted" | "failed" | "unproven" | "connected" | "canceled"; providerConnectionRef?: string; sessionId?: string; now?: string }>
  | Readonly<{ kind: "markHostPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "classMovementConsentPrepared"; actionKey: string; evidence: import("./class-movement-consent.ts").ClassMovementConsentEvidence;
      expectedConversationRevision: number; now: string }>
  | Readonly<{ kind: "hostWriteBlocked"; effectId: string; reason?: "unsupported"; now: string }>
  | Readonly<{ kind: "recoverHostPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "hostWriteResolved"; effectId: string; receipt: HostWriteReceipt; now: string }>
  | Readonly<{ kind: "reconciliationResolved"; effectId: string; observation: ReconcileObservation; now: string }>
  | Readonly<{ kind: "markStaffPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "recoverStaffPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "staffTaskResolved"; effectId: string; receipt: StaffTaskReceipt; now?: string }>
  | Readonly<{ kind: "staffTaskReconciled"; effectId: string; observation: StaffTaskObservation }>
  | Readonly<{ kind: "staffChangeRequested"; taskKey: string; actorRef: string; change: StaffChangeRequest }>
  | Readonly<{ kind: "markStaffChangePossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "recoverStaffChangePossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "staffChangeResolved"; effectId: string; receipt: StaffChangeReceipt }>
  | Readonly<{ kind: "staffChangeReconciled"; effectId: string; observation: StaffChangeObservation }>
  | Readonly<{ kind: "staffAlertRequested"; taskKey: string; reason: StaffAlertReason; now: string }>
  | Readonly<{ kind: "markOperatorAlertPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "recoverOperatorAlertPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "operatorAlertResolved"; effectId: string; receipt: OperatorAlertReceipt; now: string }>
  | Readonly<{ kind: "operatorAlertReconciled"; effectId: string; observation: OperatorAlertObservation; now: string }>
  | Readonly<{ kind: "reconciliationDeadline"; actionKey: string; now: string }>;
