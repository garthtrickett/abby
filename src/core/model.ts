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
export type AdmissionReceipt = Readonly<{ callId: string; scope: LocationScope; admission: Admission; lifecycle: "starting" | "active" | "ended" }>;
export type AdmissionResult = Readonly<{ kind: "created" | "duplicate"; receipt: AdmissionReceipt }>;
export type ActiveSessionReceipt = Readonly<{ callId: string; scope: LocationScope; lease: SessionLease }>;
export type PendingPresentationRef = Readonly<{ callId: string; scope: LocationScope; sessionId: string; presentationId: string }>;
export const POSSIBLE_SEND_RECOVERY_DELAY_MS = 60_000;
export type StaffDestination =
  | Readonly<{ kind: "owner"; ownerRef: string }>
  | Readonly<{ kind: "queue"; queueRef: string }>;
export type ActionKind = "book" | "cancel" | "reschedule" | "intake";
export type CapabilityId = ActionKind | "transfer";
export type CapabilityMode = "execute" | "requestOnly" | "unavailable";

export type CallPolicy = Readonly<{
  scope: LocationScope;
  policyVersion: string;
  bookingEnabled: boolean;
  capabilities: Readonly<Record<CapabilityId, CapabilityMode>>;
  transferDestinationRef?: string;
  staffDestination: StaffDestination;
  operatorQueue: StaffDestination;
}>;

export type VerifiedPatient = Readonly<{
  scope: LocationScope;
  patientRef: string;
  verificationRef: string;
  expiresAt: string;
}>;
export type BookableOffer = Readonly<{
  scope: LocationScope;
  offerRef: string;
  serviceRef: string;
  startsAt: string;
  expiresAt: string;
}>;
export type AppointmentTarget = Readonly<{
  scope: LocationScope;
  appointmentRef: string;
  patientRef: string;
}>;

export type ActionRequest =
  | Readonly<{ kind: "book"; patient: VerifiedPatient; offer: BookableOffer }>
  | Readonly<{ kind: "cancel"; patient: VerifiedPatient; target: AppointmentTarget }>
  | Readonly<{ kind: "reschedule"; patient: VerifiedPatient; target: AppointmentTarget; offer: BookableOffer }>
  | Readonly<{ kind: "intake"; scope: LocationScope; approvedDraftRef: string; consentRef: string; duplicateCheckRef: string }>;

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
}>;
export type AvailabilityRead = AvailabilitySnapshot | Readonly<{ kind: "notEligible"; reason: "business" | "practitioner" | "appointmentType" }>;
export type AvailabilityReadFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidRange" | "forbidden" | "notFound" | "rateLimited" | "unavailable" | "malformed" | "tooManyResults";
  resetAt?: string;
}>;

export type TurnInterpretation =
  | Readonly<{ kind: "requestAction"; request: ActionRequest }>
  | Readonly<{ kind: "affirm"; actionKey: string; digest: string; affirmative: boolean }>
  | Readonly<{ kind: "handoff"; reason: StaffReason }>
  | Readonly<{ kind: "transfer"; reason: StaffReason }>
  | Readonly<{ kind: "readFailure"; target: "patient" | "offer"; failure: "unavailable" | "notFound" }>
  | Readonly<{ kind: "unavailableAction"; actionKind: ActionKind }>
  | Readonly<{ kind: "answer"; sources: readonly ApprovedKnowledge[]; proposedText: string }>
  | Readonly<{ kind: "knowledgeFailure"; reason: "invalidQuery" | "unavailable" }>
  | Readonly<{ kind: "availability"; from: string; to: string; snapshot: AvailabilitySnapshot }>
  | Readonly<{ kind: "availabilityFailure"; reason: AvailabilityReadFailure["kind"] | "notEligible" | "notConfigured" | "unclear" }>
  | Readonly<{ kind: "ambiguousTarget" }>;

export type StaffReason =
  | "callerRequested" | "verificationFailed" | "unsupported" | "uncertainAction"
  | "partialIntake" | "systemFailure" | "transferFailed";
export type ActionStatus =
  | "awaitingConfirmation" | "ready" | "dispatched" | "committed"
  | "rejected" | "unsupported" | "uncertain" | "needsReview" | "canceled";
export type HostMutation = Readonly<{
  kind: ActionKind;
  scope: LocationScope;
  actionKey: string;
  payloadDigest: string;
  policyVersion: string;
  request: ActionRequest;
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
  | Readonly<{ kind: "committed"; actionKey: string; hostRef: string }>
  | Readonly<{ kind: "rejected"; actionKey: string; reason: "conflict" | "invalid" | "forbidden" | "expiredOffer" }>
  | Readonly<{ kind: "unsupported"; actionKey: string }>
  | Readonly<{ kind: "uncertain"; actionKey: string; reconcileAfter: string; deadline: string }>;
export type ReconcileObservation =
  | Readonly<{ kind: "exactCommit"; actionKey: string; hostRef: string }>
  | Readonly<{ kind: "definitiveNonCommit"; actionKey: string }>
  | Readonly<{ kind: "stillUnknown"; actionKey: string }>;
export type StaffTaskReceipt =
  | Readonly<{ kind: "opened"; taskKey: string; hostTaskRef: string; destination: StaffDestination }>
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
export type StaffItem = Readonly<{
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
}>;
export type Effect =
  | Readonly<{ kind: "hostWrite"; id: string; actionKey: string; mutation: HostMutation; status: "pending" | "possiblySent" | "completed" | "uncertain" | "canceled"; possiblySentAt?: string }>
  | Readonly<{ kind: "hostReconcile"; id: string; actionKey: string; originalEffectId: string; status: "pending" | "completed" }>
  | Readonly<{ kind: "staffTask"; id: string; taskKey: string; status: "pending" | "possiblySent" | "completed" | "uncertain"; possiblySentAt?: string }>
  | Readonly<{ kind: "staffReconcile"; id: string; taskKey: string; originalEffectId: string; originalItem: StaffItem; status: "pending" | "completed" }>
  | Readonly<{ kind: "staffChange"; id: string; taskKey: string; change: StaffChange; status: "pending" | "possiblySent" | "completed" | "uncertain"; possiblySentAt?: string }>
  | Readonly<{ kind: "staffChangeReconcile"; id: string; taskKey: string; originalEffectId: string; change: StaffChange; status: "pending" | "completed" }>;
export type RecoverableEffectRef = Readonly<{
  callId: string;
  scope: LocationScope;
  effectId: string;
  kind: Effect["kind"];
  status: "pending" | "possiblySent";
}>;

export type CallState = {
  callId: string;
  policy: CallPolicy;
  lifecycle: "starting" | "active" | "ended";
  admission?: Admission;
  sessionLease?: SessionLease;
  version: number;
  conversationRevision: number;
  processedTurnIds: string[];
  processedTurnDigests: Record<string, string>;
  actions: Record<string, ActionState>;
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
};

export type TransitionFailure =
  | Readonly<{ kind: "callUnknown" | "callConflict" | "versionConflict" | "invalidTransition" | "scopeMismatch" | "evidenceExpired" | "confirmationMissing" | "digestChanged" | "effectUnknown" | "keyMismatch" | "storageFailure" | "storageCorrupt" | "admissionExpired" | "leaseLost" | "staleTurn" }>;

export type TransitionAction =
  | Readonly<{ kind: "sessionActivated"; sessionId: string; now: string }>
  | Readonly<{ kind: "sessionRenewed"; sessionId: string; expectedLeaseVersion: number; now: string }>
  | Readonly<{ kind: "admissionExpired"; now: string }>
  | Readonly<{ kind: "sessionExpired"; sessionId: string; expectedLeaseVersion: number; now: string }>
  | Readonly<{ kind: "callEnded"; sessionId: string; now: string }>
  | Readonly<{ kind: "speechBegan"; sessionId: string; now: string }>
  | Readonly<{ kind: "callerTurn"; turn: FinalCallerTurn; interpretation: TurnInterpretation; now: string; expectedConversationRevision?: number }>
  | Readonly<{ kind: "presentationStarted"; presentationId: string; sessionId?: string; now?: string }>
  | Readonly<{ kind: "transferPossiblySent"; presentationId: string; sessionId: string; now: string }>
  | Readonly<{ kind: "presentationResolved"; presentationId: string; status: "played" | "interrupted" | "failed" | "unproven" | "connected" | "canceled"; providerConnectionRef?: string; sessionId?: string; now?: string }>
  | Readonly<{ kind: "markHostPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "recoverHostPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "hostWriteResolved"; effectId: string; receipt: HostWriteReceipt; now: string }>
  | Readonly<{ kind: "reconciliationResolved"; effectId: string; observation: ReconcileObservation; now: string }>
  | Readonly<{ kind: "markStaffPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "recoverStaffPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "staffTaskResolved"; effectId: string; receipt: StaffTaskReceipt }>
  | Readonly<{ kind: "staffTaskReconciled"; effectId: string; observation: StaffTaskObservation }>
  | Readonly<{ kind: "staffChangeRequested"; taskKey: string; actorRef: string; change: StaffChangeRequest }>
  | Readonly<{ kind: "markStaffChangePossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "recoverStaffChangePossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "staffChangeResolved"; effectId: string; receipt: StaffChangeReceipt }>
  | Readonly<{ kind: "staffChangeReconciled"; effectId: string; observation: StaffChangeObservation }>
  | Readonly<{ kind: "reconciliationDeadline"; actionKey: string; now: string }>;
