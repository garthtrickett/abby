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
import type { FinancialDiscoveredWork, FinancialDiscoveredAttempt, FinancialDiscoveredMessageAttempt, FinancialDiscoveredExpiryAttempt, FinancialDiscoveryRecordQuery } from "../financial-work-discovery.ts";

export class FinancialDiscoveryError extends Error {
  readonly kind: ClinikoFinancialReviewFailure["kind"];
  constructor(kind: ClinikoFinancialReviewFailure["kind"]) { super("Financial discovery unavailable"); this.kind = kind; }
}
export type FinancialListedRecord = Readonly<{ recallRef: string; patientId: string; notes: string; recalled: boolean; archivedAt: string | null }>;
type Ports = Readonly<{
  trust: Readonly<{ producerKeyRef: string; publicKey: KeyObject }>; beganAt: string;
  permitRecord(recallRef: string, actionRef: string): Promise<void>;
  readIntent(recallRef: string, actionRef: string, purpose: FinancialDiscoveryRecordQuery["purpose"]): Promise<ClinikoFinancialReviewContext>;
}>;

/** Private assembly only. Callers must authorize the account collection, every
 * selected record and exact source, and recheck those grants before disclosure.
 * Notes/attempts remain context; only the actual producer signature binds ACK. */
export async function assembleFinancialRecords(selected: readonly FinancialListedRecord[], ports: Ports): Promise<Readonly<{
  work: readonly FinancialDiscoveredWork[]; attempts: readonly FinancialDiscoveredAttempt[];
  messageAttempts?: readonly FinancialDiscoveredMessageAttempt[];
  expiryAttempts?: readonly FinancialDiscoveredExpiryAttempt[];
}>> {
  const { trust, beganAt, readIntent, permitRecord } = ports;
  if (selected.length > 50) throw new FinancialDiscoveryError("unavailable");
  const intents = new Map<string, ClinikoFinancialReviewContext>(), actions = new Set<string>();
  const observations: { native: FinancialListedRecord; proof: ClinikoFinancialBookingObservation }[] = [];
  const pendingAttempts: { native: FinancialListedRecord; attempt: FinancialCheckoutAttempt }[] = [];
  const pendingMessages: { native: FinancialListedRecord; attempt: FinancialMessageAttempt }[] = [];
  const pendingExpiries: { native: FinancialListedRecord; attempt: FinancialExpiryAttempt }[] = [];
  for (const native of selected) {
    const decoded = decodeClinikoFinancialIntent(native.notes);
    const attempt = decoded.ok ? undefined : decodeFinancialCheckoutAttempt(native.notes);
    const message = decoded.ok || attempt?.ok ? undefined : decodeFinancialMessageAttempt(native.notes);
    const expiry = decoded.ok || attempt?.ok || message?.ok ? undefined : decodeFinancialExpiryAttempt(native.notes);
    const citation = decoded.ok || attempt?.ok || message?.ok || expiry?.ok ? undefined : authenticateFinancialBookingCitation(native.notes, trust);
    const actionRef = decoded.ok ? decoded.value.actionRef : attempt?.ok ? attempt.value.actionRef : message?.ok ? message.value.actionRef : expiry?.ok ? expiry.value.actionRef : citation?.ok ? citation.value.actionRef : undefined;
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
  // Attempts are unsigned possible-dispatch context, never creation receipts.
  // A source outside this window still requires independent exact authority.
  const obligations = new Map([...work.map(w => [w.intent.recallRef, w.intent.intent] as const),
    ...attempts.map(a => [a.intent.recallRef, a.intent.intent] as const), ...messageAttempts.map(a => [a.intent.recallRef, a.intent.intent] as const), ...expiryAttempts.map(a => [a.intent.recallRef, a.intent.intent] as const)]);
  const obligationIds = new Set<string>();
  for (const intent of obligations.values()) {
    for (const id of [intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects)]) {
      if (obligationIds.has(id)) throw new FinancialDiscoveryError("mismatched"); obligationIds.add(id);
    }
  }
  for (const id of [...work.flatMap(w => w.kind === "pairedContext" ? [w.observation.actionRef] : []), ...attempts.map(a => a.attempt.actionRef), ...messageAttempts.map(a => a.attempt.actionRef), ...expiryAttempts.map(a => a.attempt.actionRef)]) {
    if (obligationIds.has(id)) throw new FinancialDiscoveryError("mismatched"); obligationIds.add(id);
  }
  return { work, attempts, ...(messageAttempts.length ? { messageAttempts } : {}), ...(expiryAttempts.length ? { expiryAttempts } : {}) };
}
