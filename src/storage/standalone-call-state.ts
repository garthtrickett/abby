import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { CallPolicy, CallState, Presentation, Result, TransitionAction, TransitionFailure } from "../core/model.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTICE_ID = /^[0-9a-f]{64}$/;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_INTERPRETATIONS = new Set([
  "clarify", "modelFallback", "requestAction", "handoff", "transfer", "ambiguousTarget", "readFailure",
  "unavailableAction", "answer", "knowledgeFailure", "availability", "availabilityFailure", "appointmentsFailure",
]);
const NOTICE_STATUSES = new Set(["pending", "started", "played", "interrupted", "failed", "unproven", "superseded"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the currently supported standalone text actions may enter the durable call ledger. */
export function standaloneTextActionAllowed(action: TransitionAction): boolean {
  if (action.kind === "callerTurn") {
    return !!action.turn && !!action.interpretation && UUID_V4.test(action.turn.callId) && UUID_V4.test(action.turn.turnId) &&
      SAFE_INTERPRETATIONS.has(action.interpretation.kind);
  }
  if (action.kind === "presentationStarted" || action.kind === "presentationResolved") {
    return NOTICE_ID.test(action.presentationId);
  }
  if (action.kind === "textPresentationWritten") return NOTICE_ID.test(action.presentationId) &&
    Number.isFinite(Date.parse(action.now));
  return false;
}

function safePolicy(policy: CallPolicy | undefined): CallPolicy | undefined {
  if (!record(policy)) return undefined;
  const scope = policy.scope;
  if (!scope || ![scope.tenantId, scope.clinicId, scope.locationId].every(value => typeof value === "string" && SCOPE_ID.test(value)) ||
      !/^\d+$/.test(policy.policyVersion) || !/^\d+$/.test(policy.automationVersion) ||
      policy.automationEnabled !== false || typeof policy.bookingEnabled !== "boolean" || policy.staffWorkEnabled !== false ||
      !policy.capabilities || (policy.capabilities.patientUpdate ?? "unavailable") !== "unavailable" || ["book", "cancel", "reschedule", "intake", "transfer"].some(kind =>
        policy.capabilities[kind as keyof CallPolicy["capabilities"]] !== "unavailable") ||
      (policy.knowledgeSnapshot !== undefined && (!Array.isArray(policy.knowledgeSnapshot) ||
        policy.knowledgeSnapshot.some(item => !item || !SCOPE_ID.test(item.sourceRef) || !/^\d+$/.test(item.version))))) return undefined;
  return {
    scope: { tenantId: scope.tenantId, clinicId: scope.clinicId, locationId: scope.locationId },
    policyVersion: policy.policyVersion,
    automationVersion: policy.automationVersion,
    automationEnabled: false,
    bookingEnabled: policy.bookingEnabled,
    capabilities: { book: "unavailable", cancel: "unavailable", reschedule: "unavailable", intake: "unavailable", transfer: "unavailable" },
    staffWorkEnabled: false,
    staffDestination: { kind: "queue", queueRef: "disabled" },
    operatorQueue: { kind: "queue", queueRef: "disabled" },
    ...(policy.knowledgeSnapshot === undefined ? {} : { knowledgeSnapshot: policy.knowledgeSnapshot.map(item => ({
      sourceRef: item.sourceRef, version: item.version,
    })) }),
  };
}

/** Rebuild from named fields. Speech and knowledge-answer text are response-only and never written. */
export function projectStandaloneTextState(state: CallState): Result<CallState, TransitionFailure> {
  const policy = safePolicy(state?.policy);
  if (!state || !policy || !UUID_V4.test(state.callId) || !["active", "ended"].includes(state.lifecycle) ||
      state.admission || state.sessionLease ||
      (state.lifecycle === "active" && state.terminal !== undefined) ||
      (state.lifecycle === "ended" && (state.terminal?.reason !== "textCompleted" ||
        typeof state.terminal.at !== "string" || !Number.isFinite(Date.parse(state.terminal.at)))) ||
      !Number.isSafeInteger(state.version) || state.version < 0 ||
      !Number.isSafeInteger(state.conversationRevision) || state.conversationRevision < 0 ||
      !Array.isArray(state.processedTurnIds) || state.processedTurnIds.some(id => !UUID_V4.test(id)) ||
      new Set(state.processedTurnIds).size !== state.processedTurnIds.length ||
      !record(state.actions) || !record(state.effects) || !record(state.staffItems) || !record(state.presentations) ||
      Object.keys(state.actions).length !== 0 || Object.keys(state.effects).length !== 0 ||
      Object.keys(state.staffItems).length !== 0 || !Array.isArray(state.availabilityReads) ||
      !Array.isArray(state.appointmentReads) ||
      !Array.isArray(state.callerMessages) || !Array.isArray(state.knowledgeAnswers)) return err({ kind: "invalidTransition" });

  const presentations: Record<string, Presentation> = {};
  for (const [id, presentation] of Object.entries(state.presentations)) {
    if (!NOTICE_ID.test(id) || presentation.kind !== "notice" || presentation.id !== id ||
        !NOTICE_STATUSES.has(presentation.status) || typeof presentation.approvedText !== "string") return err({ kind: "invalidTransition" });
    presentations[id] = { kind: "notice", id, status: presentation.status, approvedText: "" };
  }
  if (state.pendingPresentationId !== undefined &&
      presentations[state.pendingPresentationId]?.status !== "pending") return err({ kind: "invalidTransition" });
  if (state.lifecycle === "ended" && (state.pendingPresentationId !== undefined ||
      Object.values(presentations).some(item => item.status === "pending" || item.status === "started"))) {
    return err({ kind: "invalidTransition" });
  }
  return ok({
    callId: state.callId,
    policy,
    lifecycle: state.lifecycle,
    ...(state.lifecycle === "ended" ? { terminal: { reason: "textCompleted" as const, at: state.terminal!.at } } : {}),
    version: state.version,
    conversationRevision: state.conversationRevision,
    processedTurnIds: [...state.processedTurnIds],
    actions: {},
    presentations,
    ...(state.pendingPresentationId === undefined ? {} : { pendingPresentationId: state.pendingPresentationId }),
    effects: {},
    staffItems: {},
    callerMessages: [],
    knowledgeAnswers: [],
    availabilityReads: [],
    appointmentReads: [],
  });
}

export function isStoredStandaloneTextState(state: CallState): boolean {
  const projected = projectStandaloneTextState(state);
  return projected.ok && isDeepStrictEqual(projected.value, state);
}

/** Strict text events contain only opaque IDs, interpretation kinds, and delivery status. */
export function isStoredStandaloneTextEvent(kind: string, payload: unknown): boolean {
  if (!record(payload)) return false;
  const keys = Object.keys(payload).sort().join(",");
  if (kind === "callerTurn") return keys === "interpretation,turnId" &&
    typeof payload.turnId === "string" && UUID_V4.test(payload.turnId) &&
    typeof payload.interpretation === "string" && SAFE_INTERPRETATIONS.has(payload.interpretation);
  if (kind === "presentationStarted") return keys === "presentationId" &&
    typeof payload.presentationId === "string" && NOTICE_ID.test(payload.presentationId);
  if (kind === "presentationResolved") return keys === "presentationId,status" &&
    typeof payload.presentationId === "string" && NOTICE_ID.test(payload.presentationId) &&
    typeof payload.status === "string" && ["played", "interrupted", "failed", "unproven"].includes(payload.status);
  if (kind === "textPresentationWritten") return keys === "presentationId" &&
    typeof payload.presentationId === "string" && NOTICE_ID.test(payload.presentationId);
  return false;
}
