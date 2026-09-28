export type Result<Value, Failure> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; error: Failure }>;

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });
export const err = <Failure>(error: Failure): Result<never, Failure> => ({ ok: false, error });

export type LocationScope = Readonly<{ tenantId: string; clinicId: string; locationId: string }>;
export type StaffDestination =
  | Readonly<{ kind: "owner"; ownerRef: string }>
  | Readonly<{ kind: "queue"; queueRef: string }>;
export type ActionKind = "book" | "cancel" | "reschedule" | "intake";
export type CapabilityMode = "execute" | "requestOnly" | "unavailable";

export type CallPolicy = Readonly<{
  scope: LocationScope;
  policyVersion: string;
  capabilities: Readonly<Record<ActionKind, CapabilityMode>>;
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
  turnId: string;
  text: string;
  quality: "clear" | "needsClarification";
  at: string;
}>;

export type ApprovedKnowledge = Readonly<{
  scope: LocationScope;
  sourceRef: string;
  approvedText: string;
  approved: boolean;
  effectiveFrom: string;
  effectiveUntil: string;
}>;

export type TurnInterpretation =
  | Readonly<{ kind: "requestAction"; request: ActionRequest }>
  | Readonly<{ kind: "affirm"; actionKey: string; digest: string; affirmative: boolean }>
  | Readonly<{ kind: "handoff"; reason: StaffReason }>
  | Readonly<{ kind: "readFailure"; target: "patient" | "offer"; failure: "unavailable" | "notFound" }>
  | Readonly<{ kind: "answer"; sources: readonly ApprovedKnowledge[]; proposedText: string }>
  | Readonly<{ kind: "ambiguousTarget" }>;

export type StaffReason =
  | "callerRequested" | "verificationFailed" | "unsupported" | "uncertainAction"
  | "partialIntake" | "systemFailure";
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
export type Presentation = Readonly<{
  id: string;
  actionKey: string;
  digest: string;
  approvedText: string;
  status: "pending" | "started" | "played" | "interrupted" | "failed" | "superseded";
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
export type StaffItem = Readonly<{
  key: string;
  reason: StaffReason;
  destination: StaffDestination;
  dueAt: string;
  status: "requested" | "open" | "needsReview" | "failed";
  linkedActionKey?: string;
  request?: ActionRequest;
  hostTaskRef?: string;
}>;
export type Effect =
  | Readonly<{ kind: "hostWrite"; id: string; actionKey: string; mutation: HostMutation; status: "pending" | "possiblySent" | "completed" | "uncertain" | "canceled" }>
  | Readonly<{ kind: "hostReconcile"; id: string; actionKey: string; originalEffectId: string; status: "pending" | "completed" }>
  | Readonly<{ kind: "staffTask"; id: string; taskKey: string; status: "pending" | "possiblySent" | "completed" | "uncertain" }>;

export type CallState = {
  callId: string;
  policy: CallPolicy;
  version: number;
  conversationRevision: number;
  processedTurnIds: string[];
  actions: Record<string, ActionState>;
  presentations: Record<string, Presentation>;
  pendingPresentationId?: string;
  effects: Record<string, Effect>;
  staffItems: Record<string, StaffItem>;
  callerMessages: string[];
};

export type TransitionFailure =
  | Readonly<{ kind: "callUnknown" | "versionConflict" | "invalidTransition" | "scopeMismatch" | "evidenceExpired" | "confirmationMissing" | "digestChanged" | "effectUnknown" | "keyMismatch" }>;

export type TransitionAction =
  | Readonly<{ kind: "callerTurn"; turn: FinalCallerTurn; interpretation: TurnInterpretation; now: string }>
  | Readonly<{ kind: "presentationStarted"; presentationId: string }>
  | Readonly<{ kind: "presentationResolved"; presentationId: string; status: "played" | "interrupted" | "failed" }>
  | Readonly<{ kind: "markHostPossiblySent"; effectId: string; now: string }>
  | Readonly<{ kind: "hostWriteResolved"; effectId: string; receipt: HostWriteReceipt; now: string }>
  | Readonly<{ kind: "reconciliationResolved"; effectId: string; observation: ReconcileObservation; now: string }>
  | Readonly<{ kind: "markStaffPossiblySent"; effectId: string }>
  | Readonly<{ kind: "staffTaskResolved"; effectId: string; receipt: StaffTaskReceipt }>
  | Readonly<{ kind: "reconciliationDeadline"; actionKey: string; now: string }>;
