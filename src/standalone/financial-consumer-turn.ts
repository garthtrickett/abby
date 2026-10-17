import { financialIntentDigest } from "../cliniko/financial-booking-observation.ts";
import type { FinancialDiscoveredWork, FinancialDiscoveredAttempt } from "../cliniko/financial-work-discovery.ts";
import { validRecallDate } from "../cliniko/recall-note.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { StripeCheckoutDiscovery } from "../stripe/checkout-discovery.ts";
import type { StripeCheckoutReader } from "../stripe/checkout-read.ts";
import type { ClinikoStripeCheckoutOwner, CheckoutCreationReceipt } from "./cliniko-stripe-checkout.ts";
import type { ClinikoFinancialMessageOwner, FinancialMessageBinding } from "./cliniko-financial-message-owner.ts";

export type FinancialConsumerPair = Extract<FinancialDiscoveredWork, { kind: "pairedContext" }>;
export type FinancialConsumerWorkQuery = Readonly<{
  purpose: "consumeNativeFinancialWork"; ownerBinding: string; pair: FinancialConsumerPair;
}>;
export type FinancialConsumerProviderQuery = FinancialConsumerWorkQuery & Readonly<{
  attempt: FinancialDiscoveredAttempt; checkoutRef: string;
}>;
/** Provisioned independently of notes, ended caller proof, metadata, a webhook,
 * the polling timer or an absent claim. Review date is explicitly clinic-owned.
 * Provider approval must establish the exact Session's obligation independently
 * of mutable metadata, including after a lost creation acknowledgement. */
export type FinancialConsumerAuthority = Readonly<{
  authorizeWork(query: FinancialConsumerWorkQuery, signal: AbortSignal): Promise<Readonly<{ reviewDate: string }> | null>;
  providerBindingAuthorized(query: FinancialConsumerProviderQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialConsumerWorkQuery | FinancialConsumerProviderQuery, signal: AbortSignal): boolean;
  /** Actual acknowledgement observer only. Failure cannot erase creation or
   * permit a replacement. This must not persist private data in Abby SQL. */
  onCheckoutAcknowledged(receipt: CheckoutCreationReceipt, signal: AbortSignal): Promise<void>;
}>;
export type FinancialConsumerTurnResult = "creationAcknowledged" | "messageAccepted" | "alreadyAttempted" | "reviewRequired";
type Ports = Readonly<{
  ownerBinding: string; authority: FinancialConsumerAuthority; checkout: ClinikoStripeCheckoutOwner;
  discovery: StripeCheckoutDiscovery; money: StripeCheckoutReader; messages: ClinikoFinancialMessageOwner;
}>;
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function open(pair: FinancialConsumerPair): boolean {
  return !pair.intent.recalled && pair.intent.archivedAt === null && !pair.recalled && pair.archivedAt === null;
}
function matches(pair: FinancialConsumerPair, a: FinancialDiscoveredAttempt): boolean {
  const i = pair.intent.intent, p = a.attempt;
  return !a.recalled && a.archivedAt === null && !a.intent.recalled && a.intent.archivedAt === null &&
    a.intent.recallRef === pair.intent.recallRef && p.financialActionRef === i.actionRef && p.effectRef === i.effects.checkout &&
    p.intentRecallRef === pair.intent.recallRef && p.intentDigest === financialIntentDigest(i) &&
    p.observationRecallRef === pair.observationRecallRef && p.observationActionRef === pair.observation.actionRef && p.targetRef === pair.observation.targetRef;
}

/** One sequential private turn. A scan is context; effect owners independently
 * reread and authorize every source, recipient and possible write. All results
 * are fixed operational classifications with no patient/provider references. */
export async function consumeFinancialPair(pair: FinancialConsumerPair, attempts: readonly FinancialDiscoveredAttempt[],
  ports: Ports, signal: AbortSignal): Promise<FinancialConsumerTurnResult> {
  const q = frozen({ purpose: "consumeNativeFinancialWork" as const, ownerBinding: ports.ownerBinding, pair });
  const wait = async <T>(task: Promise<T>) => {
    const result = await awaitUntilAbort(task, signal);
    if (result === undefined || signal.aborted || ports.authority.current(q, signal) !== true) throw new Error("Financial turn unavailable");
    return result;
  };
  const permit = async () => {
    const grant = await wait(Promise.resolve().then(() => ports.authority.authorizeWork(q, signal)));
    if (!grant || !validRecallDate(grant.reviewDate)) throw new Error("Financial turn forbidden");
    return grant;
  };
  try {
    if (signal.aborted || !open(pair)) return "reviewRequired";
    const grant = await permit(), intent = pair.intent.intent;
    const prior = attempts.filter(a => a.attempt.financialActionRef === intent.actionRef || a.attempt.effectRef === intent.effects.checkout);
    if (prior.length > 1 || prior[0] && !matches(pair, prior[0])) return "reviewRequired";
    const attempt = prior[0];
    if (!attempt) {
      const created = await wait(ports.checkout.createOnce({ intentRecallRef: pair.intent.recallRef, financialActionRef: intent.actionRef,
        observationRecallRef: pair.observationRecallRef, observationActionRef: pair.observation.actionRef, reviewDate: grant.reviewDate }, signal));
      if (!created.ok || created.value.kind !== "created") return "reviewRequired";
      const receipt = created.value.receipt;
      // Compare against the owner's actual POST context, not a reconstructed
      // receipt assembled from this earlier pending scan and later metadata.
      if (receipt.intentRecallRef !== pair.intent.recallRef || receipt.financialActionRef !== intent.actionRef ||
          receipt.observationRecallRef !== pair.observationRecallRef || receipt.observationActionRef !== pair.observation.actionRef ||
          receipt.intentDigest !== financialIntentDigest(intent) || receipt.targetRef !== pair.observation.targetRef ||
          receipt.accountRef !== intent.stripe.accountRef || receipt.livemode !== intent.stripe.livemode ||
          receipt.amount !== intent.payment.amount || receipt.currency !== intent.payment.currency) return "reviewRequired";
      await wait(Promise.resolve().then(() => ports.authority.onCheckoutAcknowledged(receipt, signal)));
      // Rediscovery on the next poll supplies the exact durable attempt. Never
      // synthesize native record fields or use a volatile receipt as work storage.
      return "creationAcknowledged";
    }
    const found = await wait(ports.discovery.findPossibleCreation({ actionRef: intent.actionRef, amount: intent.payment.amount,
      currency: intent.payment.currency, createdFrom: attempt.attempt.createdFrom, createdTo: attempt.attempt.createdThrough }, signal));
    if (!found.ok || found.value.kind !== "observed") return "reviewRequired";
    const providerQuery = frozen({ ...q, attempt, checkoutRef: found.value.checkoutRef });
    if (await wait(Promise.resolve().then(() => ports.authority.providerBindingAuthorized(providerQuery, signal))) !== true ||
        ports.authority.current(providerQuery, signal) !== true) return "reviewRequired";
    await permit();
    const money = await wait(ports.money.inspect({ checkoutRef: found.value.checkoutRef, actionRef: intent.actionRef,
      amount: intent.payment.amount, currency: intent.payment.currency }, signal));
    if (!money.ok || ports.authority.current(providerQuery, signal) !== true) return "reviewRequired";
    const purpose = money.value.kind === "received" && money.value.receiptUrl !== null ? "receiptDelivery"
      : money.value.kind === "unpaid" && money.value.status === "open" && !money.value.paymentClosed ? "linkDelivery" : null;
    if (!purpose) return "reviewRequired";
    await permit();
    if (await wait(Promise.resolve().then(() => ports.authority.providerBindingAuthorized(providerQuery, signal))) !== true ||
        ports.authority.current(providerQuery, signal) !== true) return "reviewRequired";
    const binding: FinancialMessageBinding = { intentRecallRef: pair.intent.recallRef, financialActionRef: intent.actionRef, observationRecallRef: pair.observationRecallRef,
      observationActionRef: pair.observation.actionRef, checkoutAttemptRecallRef: attempt.recallRef,
      checkoutAttemptActionRef: attempt.attempt.actionRef, checkoutRef: found.value.checkoutRef };
    // Do not let a later lifecycle/observer failure erase an acknowledged SMTP
    // acceptance. The message owner itself performs the final fresh gates.
    const sent = await ports.messages.sendOnce(binding, purpose, signal);
    return sent.ok && sent.value.kind === "accepted" ? "messageAccepted"
      : !sent.ok && sent.error.kind === "alreadyClaimed" ? "alreadyAttempted" : "reviewRequired";
  } catch { return "reviewRequired"; }
}
