import { isDeepStrictEqual } from "node:util";
import { digestActionRequest, digestTurn } from "./digest.ts";
import { classMovementCanContinue } from "./class-movement-progress.ts";
import type { PendingClassMovementStage } from "./class-movement-continuation.ts";
import type { ActionRequest, ActionState, CallState, VerifiedPatient } from "./model.ts";

/** A current host-issued subject proof, bound to the live call and exact next
 * native stage. This record cannot reconstruct a host stage owner. */
export type ClassMovementConsentEvidence = Readonly<{
  callId: string; sessionId: string; policyVersion: string;
  continuation: PendingClassMovementStage; patient: VerifiedPatient;
  /** Issued independently by the live native owner after current policy checks.
   * Renewal may change this expiry, never the original contract version/text. */
  terms: Extract<ActionRequest, { kind: "reschedule" }>["terms"]; expiresAt: string;
}>;
export type ClassMovementConsent = Readonly<{
  evidence: ClassMovementConsentEvidence; digest: string;
}>;
export type ClassMovementPreparation = Readonly<{ kind: "verificationRequired" }> | Readonly<{ kind: "needsReview" }> |
  Readonly<{ kind: "quotaWait"; seconds: number }> |
  Readonly<{ kind: "ready"; evidence: ClassMovementConsentEvidence; expectedConversationRevision: number }>;

const phaseDescription: Readonly<Record<PendingClassMovementStage["stage"], string>> = {
  replacement: "create the replacement class attendance",
  original: "cancel the original class attendance",
  association: "associate the replacement attendance with its approved membership case",
  associationInspection: "inspect whether the class move and membership association are complete; this inspection makes no further attendance change",
  compensation: "cancel the replacement attendance to restore the original arrangement",
  compensationInspection: "inspect whether the original arrangement has been restored; this inspection makes no further attendance change",
};
export function classMovementConsentText(consent: ClassMovementConsent): string {
  return `Please give a separate confirmation to ${phaseDescription[consent.evidence.continuation.stage]}. This confirms only this stage. The overall class move remains unconfirmed until all required stages are inspected.`;
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) return undefined;
    const copy: Record<string, unknown> = {};
    for (const key of fields) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) return undefined;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return undefined; }
}
const ref = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value);
const instant = (value: unknown): number => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? Date.parse(value) : NaN;

/** Necessary SAM checks before presenting and before dispatching a phase.
 * The host must separately recheck its live owner, private proof, permission,
 * native observations, approval and physical quota at the eventual send. A still-live
 * proof can cover another stage; each stage has its own one-use played consent.
 * Replacing expired proof requires private verifier succession, never a longer expiry.
 * The admission deadline bounds activation; after activation the live session
 * lease bounds consent, including across quota windows. */
export function readClassMovementConsent(state: CallState, action: ActionState, input: unknown,
  now: string): ClassMovementConsent | undefined {
  if (!["pendingContinuation", "awaitingConfirmation", "ready"].includes(action.status) ||
      Object.values(state.effects).some(effect => effect.kind === "hostWrite" && effect.actionKey === action.key && effect.status === "possiblySent")) return undefined;
  return boundConsent(state, action, input, now);
}

function boundConsent(state: CallState, action: ActionState, input: unknown, now: string): ClassMovementConsent | undefined {
  const movement = action.classMovement, request = action.mutation.request, lease = state.sessionLease;
  const at = instant(now), leaseExpiry = instant(lease?.expiresAt), admissionDeadline = instant(state.admission?.deadline);
  if (state.lifecycle !== "active" || state.callerIdentityDenied || !state.admission || !lease ||
      !Number.isFinite(at) || !Number.isFinite(leaseExpiry) || !Number.isFinite(admissionDeadline) || at >= leaseExpiry ||
      !state.policy.automationEnabled || !state.policy.staffWorkEnabled || !state.policy.reschedulingEnabled ||
      state.policy.capabilities.reschedule !== "execute" || state.policy.policyVersion !== action.mutation.policyVersion ||
      request.kind !== "reschedule" || !movement || movement.outcome !== "pending" ||
      !classMovementCanContinue(movement.progress, movement.continuation.stage)) return undefined;
  const read = record(input, ["callId", "sessionId", "policyVersion", "continuation", "patient", "terms", "expiresAt"]);
  if (!read || read.callId !== state.callId || read.sessionId !== lease.sessionId || read.policyVersion !== state.policy.policyVersion) return undefined;
  const continuation = record(read.continuation, ["ref", "contractVersion", "ordinal", "stage"]);
  if (!continuation || Object.entries(movement.continuation).some(([key, value]) => continuation[key] !== value)) return undefined;
  const patient = record(read.patient, ["scope", "patientRef", "verificationRef", "expiresAt"]);
  const scope = patient && record(patient.scope, ["tenantId", "clinicId", "locationId"]);
  if (!patient || !scope || Object.entries(state.policy.scope).some(([key, value]) => scope[key] !== value) ||
      patient.patientRef !== request.patient.patientRef || !ref(patient.verificationRef)) return undefined;
  const terms = record(read.terms, ["version", "approvedText", "expiresAt"]);
  if (!terms || !ref(terms.version) || terms.version !== request.terms.version || terms.approvedText !== request.terms.approvedText) return undefined;
  const expires = instant(read.expiresAt), proofExpires = instant(patient.expiresAt), termsExpiry = instant(terms.expiresAt);
  if (!Number.isFinite(expires) || !Number.isFinite(proofExpires) || !Number.isFinite(termsExpiry) || termsExpiry <= at ||
      expires <= at || expires - at > 120_000 || expires > proofExpires || expires > leaseExpiry || expires > termsExpiry ||
      movement.continuation.stage === "replacement" && (!Number.isFinite(instant(request.offer.expiresAt)) || expires > instant(request.offer.expiresAt))) return undefined;
  const evidence: ClassMovementConsentEvidence = Object.freeze({ callId: state.callId, sessionId: lease.sessionId,
    policyVersion: state.policy.policyVersion, continuation: Object.freeze({ ...movement.continuation }),
    patient: Object.freeze({ scope: Object.freeze({ ...state.policy.scope }), patientRef: request.patient.patientRef,
      verificationRef: patient.verificationRef, expiresAt: patient.expiresAt as string }),
    terms: Object.freeze({ version: request.terms.version, approvedText: request.terms.approvedText, expiresAt: terms.expiresAt as string }),
    expiresAt: read.expiresAt as string });
  // Include inspected progress as well as both targets' immutable action digest.
  // A new observation or a rotated stage/proof requires a different playback.
  const digest = digestTurn({ kind: "classMovementConsent", actionKey: action.key, originalDigest: action.digest,
    progress: movement.progress, evidence });
  return Object.freeze({ evidence, digest });
}

/** Necessary SAM evidence for the exact phase already in flight. This cannot
 * admit another effect; the native owner still checks proof, policy, permission,
 * observations and physical quota at each provider operation. */
export function readActiveClassMovementConsent(state: CallState, effectId: string, now: string): ClassMovementConsent | undefined {
  try {
    const effect = state.effects[effectId];
    if (!effect || effect.kind !== "hostWrite" || effect.id !== effectId || effect.status !== "possiblySent" || !effect.classMovementConsent || effect.mutation.notification) return undefined;
    const action = state.actions[effect.actionKey], consent = action?.classMovementConsent;
    if (!action || action.kind !== "reschedule" || action.status !== "dispatched" || !consent ||
        effectId !== `${action.key}:classStage:${consent.digest}` || effect.mutation.actionKey !== action.key ||
        effect.mutation.payloadDigest !== action.digest || digestActionRequest(action.mutation.request) !== action.digest ||
        !isDeepStrictEqual(effect.mutation, action.mutation) || !isDeepStrictEqual(action.mutation.scope, state.policy.scope) ||
        !isDeepStrictEqual(effect.classMovementConsent.evidence, consent.evidence) || effect.classMovementConsent.digest !== consent.digest ||
        !Number.isFinite(instant(consent.playedAt)) || instant(consent.playedAt) > instant(now) || state.pendingPresentationId ||
        Object.values(state.presentations).some(item => item.status === "started" || item.status === "possiblySent") ||
        Object.values(state.effects).some(item => item.kind === "hostWrite" && item.actionKey === action.key && item.status === "possiblySent" && item.id !== effectId)) return undefined;
    const played = state.presentations[consent.presentationId];
    if (played?.kind !== "speech" || played.actionKey !== action.key || played.digest !== consent.digest || played.status !== "played") return undefined;
    const current = boundConsent(state, action, effect.classMovementConsent.evidence, now);
    return current?.digest === consent.digest ? current : undefined;
  } catch { return undefined; }
}
