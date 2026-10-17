import { decodeFinancialResendAttempt, resendAttemptMatchesRequest } from "../financial-resend-attempt.ts";
import type { FinancialResendAttempt } from "../financial-resend-attempt.ts";
import type { FinancialResendContext } from "../financial-resend-records.ts";
import type { ClinikoFinancialIntent } from "../financial-review-intent.ts";
import { decodeFinancialResendRequest, resendRequestMatchesIntent } from "../financial-resend-request.ts";
import type { FinancialResendRequest } from "../financial-resend-request.ts";
import type { KeyObject } from "node:crypto";
import { decodeFinancialCheckoutAttempt, checkoutAttemptMatchesIntent } from "../financial-checkout-attempt.ts";
import type { FinancialCheckoutAttempt } from "../financial-checkout-attempt.ts";
import { decodeFinancialMessageAttempt, messageAttemptMatchesIntent } from "../financial-message-attempt.ts";
import type { FinancialMessageAttempt } from "../financial-message-attempt.ts";
import { decodeFinancialExpiryAttempt, expiryAttemptMatchesIntent } from "../financial-expiry-attempt.ts";
import type { FinancialExpiryAttempt } from "../financial-expiry-attempt.ts";
import { financialIntentDigest, authenticateFinancialBookingCitation, verifyFinancialBookingObservation } from "../financial-booking-observation.ts";
import type { ClinikoFinancialBookingObservation } from "../financial-booking-observation.ts";
import { decodeClinikoFinancialIntent } from "../financial-review-intent.ts";
import type { ClinikoFinancialReviewContext, ClinikoFinancialReviewFailure } from "../financial-review-read.ts";
import type { FinancialDiscoveredWork, FinancialDiscoveredAttempt, FinancialDiscoveredMessageAttempt, FinancialDiscoveredExpiryAttempt, FinancialDiscoveredResendRequest, FinancialDiscoveredResendAttempt, FinancialDiscoveryRecordQuery } from "../financial-work-discovery.ts";

export class FinancialDiscoveryError extends Error {
  readonly kind: ClinikoFinancialReviewFailure["kind"];
  constructor(kind: ClinikoFinancialReviewFailure["kind"]) { super("Financial discovery unavailable"); this.kind = kind; }
}
export type FinancialListedRecord = Readonly<{ recallRef: string; patientId: string; notes: string; recalled: boolean; archivedAt: string | null }>;
type Ports = Readonly<{
  trust: Readonly<{ producerKeyRef: string; publicKey: KeyObject }>; beganAt: string;
  permitRecord(recallRef: string, actionRef: string): Promise<void>;
  readResendRequest(recallRef: string, actionRef: string, intentRecallRef: string, intent: ClinikoFinancialIntent): Promise<FinancialResendContext>;
  readIntent(recallRef: string, actionRef: string, purpose: FinancialDiscoveryRecordQuery["purpose"]): Promise<ClinikoFinancialReviewContext>;
}>;

/** Private assembly only. Callers must authorize the account collection, every
 * selected record and exact source, and recheck those grants before disclosure.
 * Notes/attempts remain context; only the actual producer signature binds ACK. */
export async function assembleFinancialRecords(selected: readonly FinancialListedRecord[], ports: Ports): Promise<Readonly<{
  work: readonly FinancialDiscoveredWork[]; attempts: readonly FinancialDiscoveredAttempt[];
  messageAttempts?: readonly FinancialDiscoveredMessageAttempt[];
  expiryAttempts?: readonly FinancialDiscoveredExpiryAttempt[];
  resendRequests?: readonly FinancialDiscoveredResendRequest[];
  resendAttempts?: readonly FinancialDiscoveredResendAttempt[];
}>> {
  const { trust, beganAt, readIntent, readResendRequest, permitRecord } = ports;
  if (selected.length > 50) throw new FinancialDiscoveryError("unavailable");
  const intents = new Map<string, ClinikoFinancialReviewContext>(), actions = new Set<string>();
  const observations: { native: FinancialListedRecord; proof: ClinikoFinancialBookingObservation }[] = [];
  const pendingAttempts: { native: FinancialListedRecord; attempt: FinancialCheckoutAttempt }[] = [];
  const pendingMessages: { native: FinancialListedRecord; attempt: FinancialMessageAttempt }[] = [];
  const pendingExpiries: { native: FinancialListedRecord; attempt: FinancialExpiryAttempt }[] = [];
  const pendingResends: { native: FinancialListedRecord; request: FinancialResendRequest }[] = [];
  const pendingResendAttempts: { native: FinancialListedRecord; attempt: FinancialResendAttempt }[] = [];
  for (const native of selected) {
    const decoded = decodeClinikoFinancialIntent(native.notes);
    const attempt = decoded.ok ? undefined : decodeFinancialCheckoutAttempt(native.notes);
    const message = decoded.ok || attempt?.ok ? undefined : decodeFinancialMessageAttempt(native.notes);
    const expiry = decoded.ok || attempt?.ok || message?.ok ? undefined : decodeFinancialExpiryAttempt(native.notes);
    const possibleResend = decoded.ok || attempt?.ok || message?.ok || expiry?.ok ? undefined : decodeFinancialResendAttempt(native.notes);
    const resend = decoded.ok || attempt?.ok || message?.ok || expiry?.ok || possibleResend?.ok ? undefined : decodeFinancialResendRequest(native.notes);
    const citation = decoded.ok || attempt?.ok || message?.ok || expiry?.ok || possibleResend?.ok || resend?.ok ? undefined : authenticateFinancialBookingCitation(native.notes, trust);
    const actionRef = decoded.ok ? decoded.value.actionRef : attempt?.ok ? attempt.value.actionRef : message?.ok ? message.value.actionRef : expiry?.ok ? expiry.value.actionRef : possibleResend?.ok ? possibleResend.value.actionRef : resend?.ok ? resend.value.actionRef : citation?.ok ? citation.value.actionRef : undefined;
    if (!actionRef || actions.has(actionRef)) throw new FinancialDiscoveryError("mismatched");
    actions.add(actionRef);
    await permitRecord(native.recallRef, actionRef);
    if (decoded.ok) {
      const context = await readIntent(native.recallRef, actionRef, "listedFinancialRecord");
      // Reject record mutation during discovery rather than mix two contexts.
      if (JSON.stringify(context.intent) !== JSON.stringify(decoded.value) || context.intent.patientId !== native.patientId ||
          context.recalled !== native.recalled || context.archivedAt !== native.archivedAt) throw new FinancialDiscoveryError("mismatched");
      intents.set(native.recallRef, context);
    } else if (attempt?.ok) pendingAttempts.push({ native, attempt: attempt.value });
    else if (message?.ok) pendingMessages.push({ native, attempt: message.value });
    else if (expiry?.ok) pendingExpiries.push({ native, attempt: expiry.value });
    else if (possibleResend?.ok) pendingResendAttempts.push({ native, attempt: possibleResend.value });
    else if (resend?.ok) pendingResends.push({ native, request: resend.value });
    else if (citation?.ok) observations.push({ native, proof: citation.value });
    else throw new FinancialDiscoveryError("malformed");
  }
  const paired = new Set<string>(), targets = new Set<string>(), bookingActions = new Set<string>(), work: FinancialDiscoveredWork[] = [];
  for (const { native, proof } of observations) {
    if (proof.intentRecallRef === native.recallRef || paired.has(proof.intentRecallRef) || targets.has(proof.targetRef) || bookingActions.has(proof.bookingActionRef)) throw new FinancialDiscoveryError("mismatched");
    const intent = intents.get(proof.intentRecallRef) ?? await readIntent(proof.intentRecallRef, proof.financialActionRef, "sourceIntent");
    const bound = verifyFinancialBookingObservation(native.notes, { intent: intent.intent, intentRecallRef: intent.recallRef, ...trust });
    if (!bound.ok || intent.intent.patientId !== native.patientId || Date.parse(proof.observedAt) > Date.parse(beganAt) + 30_000) throw new FinancialDiscoveryError("mismatched");
    paired.add(proof.intentRecallRef); targets.add(proof.targetRef); bookingActions.add(proof.bookingActionRef);
    work.push({ kind: "pairedContext", intent, observation: bound.value, observationRecallRef: native.recallRef,
      recalled: native.recalled, archivedAt: native.archivedAt });
  }
  for (const [ref, intent] of intents) if (!paired.has(ref)) work.push({ kind: "intentContext", intent });
  const attempts: FinancialDiscoveredAttempt[] = [], attempted = new Set<string>();
  for (const { native, attempt } of pendingAttempts) {
    if (native.recallRef === attempt.intentRecallRef || native.recallRef === attempt.observationRecallRef || attempted.has(attempt.effectRef)) throw new FinancialDiscoveryError("mismatched");
    const intent = intents.get(attempt.intentRecallRef) ?? await readIntent(attempt.intentRecallRef, attempt.financialActionRef, "sourceIntent");
    if (!checkoutAttemptMatchesIntent(attempt, intent.intent, intent.recallRef) || intent.intent.patientId !== native.patientId) throw new FinancialDiscoveryError("mismatched");
    const pair = work.find(w => w.kind === "pairedContext" && w.intent.recallRef === intent.recallRef);
    if (pair?.kind === "pairedContext" && (pair.observationRecallRef !== attempt.observationRecallRef ||
        pair.observation.actionRef !== attempt.observationActionRef || pair.observation.targetRef !== attempt.targetRef ||
        financialIntentDigest(pair.intent.intent) !== attempt.intentDigest)) throw new FinancialDiscoveryError("mismatched");
    attempted.add(attempt.effectRef);
    attempts.push({ kind: "attemptContext", intent, attempt, recallRef: native.recallRef, recalled: native.recalled, archivedAt: native.archivedAt });
  }
  const messageAttempts: FinancialDiscoveredMessageAttempt[] = [];
  for (const { native, attempt } of pendingMessages) {
    if (native.recallRef === attempt.intentRecallRef || native.recallRef === attempt.observationRecallRef || attempted.has(attempt.effectRef) ||
        Date.parse(attempt.attemptedAt) > Date.parse(beganAt) + 30_000) throw new FinancialDiscoveryError("mismatched");
    const intent = intents.get(attempt.intentRecallRef) ?? await readIntent(attempt.intentRecallRef, attempt.financialActionRef, "sourceIntent");
    if (!messageAttemptMatchesIntent(attempt, intent.intent, intent.recallRef) || intent.intent.patientId !== native.patientId) throw new FinancialDiscoveryError("mismatched");
    const pair = work.find(w => w.kind === "pairedContext" && w.intent.recallRef === intent.recallRef);
    if (pair?.kind === "pairedContext" && (pair.observationRecallRef !== attempt.observationRecallRef || pair.observation.actionRef !== attempt.observationActionRef ||
        pair.observation.targetRef !== attempt.targetRef || financialIntentDigest(pair.intent.intent) !== attempt.intentDigest)) throw new FinancialDiscoveryError("mismatched");
    attempted.add(attempt.effectRef);
    messageAttempts.push({ kind: "messageAttemptContext", intent, attempt, recallRef: native.recallRef,
      recalled: native.recalled, archivedAt: native.archivedAt });
  }
  const expiryAttempts: FinancialDiscoveredExpiryAttempt[] = [];
  for (const { native, attempt } of pendingExpiries) {
    if (native.recallRef === attempt.intentRecallRef || native.recallRef === attempt.observationRecallRef || attempted.has(attempt.effectRef) ||
        Date.parse(attempt.attemptedAt) > Date.parse(beganAt) + 30_000) throw new FinancialDiscoveryError("mismatched");
    const intent = intents.get(attempt.intentRecallRef) ?? await readIntent(attempt.intentRecallRef, attempt.financialActionRef, "sourceIntent");
    if (!expiryAttemptMatchesIntent(attempt, intent.intent, intent.recallRef) || intent.intent.patientId !== native.patientId) throw new FinancialDiscoveryError("mismatched");
    const pair = work.find(w => w.kind === "pairedContext" && w.intent.recallRef === intent.recallRef);
    if (pair?.kind === "pairedContext" && (pair.observationRecallRef !== attempt.observationRecallRef || pair.observation.actionRef !== attempt.observationActionRef ||
        pair.observation.targetRef !== attempt.targetRef || financialIntentDigest(pair.intent.intent) !== attempt.intentDigest)) throw new FinancialDiscoveryError("mismatched");
    attempted.add(attempt.effectRef);
    expiryAttempts.push({ kind: "expiryAttemptContext", intent, attempt, recallRef: native.recallRef,
      recalled: native.recalled, archivedAt: native.archivedAt });
  }
  const sameResendSources = (request: FinancialResendRequest): boolean => {
    const pair = work.find(w => w.kind === "pairedContext" && w.request.intentRecallRef === request.intentRecallRef);
    if (pair?.kind === "pairedContext" && (pair.observationRecallRef !== request.observationRecallRef || pair.observation.actionRef !== request.observationActionRef ||
        pair.observation.targetRef !== request.targetRef)) return false;
    const creation = attempts.find(a => a.recallRef === request.checkoutAttemptRecallRef);
    if (creation && (creation.attempt.actionRef !== request.checkoutAttemptActionRef || creation.attempt.financialActionRef !== request.financialActionRef ||
        creation.attempt.intentRecallRef !== request.intentRecallRef || creation.attempt.observationRecallRef !== request.observationRecallRef ||
        creation.attempt.observationActionRef !== request.observationActionRef || creation.attempt.targetRef !== request.targetRef)) return false;
    return true;
  };
  const resendRequests: FinancialDiscoveredResendRequest[] = [], declaredEffects = new Set<string>();
  for (const { native, request } of pendingResends) {
    if ([request.intentRecallRef, request.observationRecallRef, request.checkoutAttemptRecallRef].includes(native.recallRef) ||
        (attempted.has(request.effectRef) || declaredEffects.has(request.effectRef)) || Date.parse(request.requestedAt) > Date.parse(beganAt) + 30_000) throw new FinancialDiscoveryError("mismatched");
    const intent = intents.get(request.intentRecallRef) ?? await readIntent(request.intentRecallRef, request.financialActionRef, "sourceIntent");
    if (!resendRequestMatchesIntent(request, intent.intent, intent.recallRef) || intent.intent.patientId !== native.patientId) throw new FinancialDiscoveryError("mismatched");
    if (!sameResendSources(request)) throw new FinancialDiscoveryError("mismatched");
    declaredEffects.add(request.effectRef);
    resendRequests.push({ kind: "resendRequestContext", intent, request, recallRef: native.recallRef, recalled: native.recalled, archivedAt: native.archivedAt });
  }
  const requestContexts = new Map<string, FinancialResendContext>();
  for (const r of resendRequests) requestContexts.set(r.recallRef,
    { kind: "resendRequestContext", recallRef: r.recallRef, request: r.request, recalled: r.recalled, archivedAt: r.archivedAt });
  const resendAttempts: FinancialDiscoveredResendAttempt[] = [];
  for (const { native, attempt } of pendingResendAttempts) {
    if ([attempt.intentRecallRef, attempt.observationRecallRef, attempt.requestRecallRef].includes(native.recallRef) || attempted.has(attempt.effectRef) ||
        Date.parse(attempt.attemptedAt) > Date.parse(beganAt) + 30_000) throw new FinancialDiscoveryError("mismatched");
    const intent = intents.get(attempt.intentRecallRef) ?? await readIntent(attempt.intentRecallRef, attempt.financialActionRef, "sourceIntent");
    if (intent.intent.patientId !== native.patientId) throw new FinancialDiscoveryError("mismatched");
    const request = await readResendRequest(attempt.requestRecallRef, attempt.requestActionRef, attempt.intentRecallRef, intent.intent);
    if (!sameResendSources(request.request) || !resendAttemptMatchesRequest(attempt, request.request, request.recallRef, intent.intent) ||
        request.request.checkoutAttemptRecallRef === native.recallRef) throw new FinancialDiscoveryError("mismatched");
    const listed = requestContexts.get(request.recallRef);
    if (listed && (JSON.stringify(listed.request) !== JSON.stringify(request.request) || listed.recalled !== request.recalled ||
        listed.archivedAt !== request.archivedAt)) throw new FinancialDiscoveryError("mismatched");
    requestContexts.set(request.recallRef, request); attempted.add(attempt.effectRef);
    resendAttempts.push({ kind: "resendAttemptContext", intent, request, attempt, recallRef: native.recallRef, recalled: native.recalled, archivedAt: native.archivedAt });
  }
  // Attempts are unsigned possible-dispatch context, never creation receipts.
  // A source outside this window still requires independent exact authority.
  const obligations = new Map([...work.map(w => [w.intent.recallRef, w.intent.intent] as const),
    ...attempts.map(a => [a.intent.recallRef, a.intent.intent] as const), ...messageAttempts.map(a => [a.intent.recallRef, a.intent.intent] as const), ...expiryAttempts.map(a => [a.intent.recallRef, a.intent.intent] as const), ...resendRequests.map(a => [a.intent.recallRef, a.intent.intent] as const), ...resendAttempts.map(a => [a.intent.recallRef, a.intent.intent] as const)]);
  const obligationIds = new Set<string>();
  for (const intent of obligations.values()) {
    for (const id of [intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects)]) {
      if (obligationIds.has(id)) throw new FinancialDiscoveryError("mismatched"); obligationIds.add(id);
    }
  }
  for (const id of [...work.flatMap(w => w.kind === "pairedContext" ? [w.observation.actionRef] : []), ...attempts.map(a => a.attempt.actionRef), ...messageAttempts.map(a => a.attempt.actionRef), ...expiryAttempts.map(a => a.attempt.actionRef), ...resendAttempts.map(a => a.attempt.actionRef)]) {
    if (obligationIds.has(id)) throw new FinancialDiscoveryError("mismatched"); obligationIds.add(id);
  }
  for (const request of [...requestContexts.values()].map(r => r.request)) {
    for (const id of [request.actionRef, request.effectRef, request.approvalRef]) {
      if (obligationIds.has(id)) throw new FinancialDiscoveryError("mismatched"); obligationIds.add(id);
    }
  }
  return { work, attempts, ...(resendAttempts.length ? { resendAttempts } : {}), ...(resendRequests.length ? { resendRequests } : {}), ...(messageAttempts.length ? { messageAttempts } : {}), ...(expiryAttempts.length ? { expiryAttempts } : {}) };
}
