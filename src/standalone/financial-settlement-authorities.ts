import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { ClinikoFinancialConsumer } from "./cliniko-financial-consumer.ts";
import type { FinancialConsumerAuthorities, FinancialConsumerConfig } from "./cliniko-financial-consumer.ts";
import type { FinancialExpiryAuthority, FinancialExpiryApproval } from "./financial-clinical-expiry-protocol.ts";
import type { FinancialMessageQuery } from "./financial-message-protocol.ts";
import { ClinikoFinancialSettlementReview } from "./cliniko-financial-settlement-review.ts";

/** Total reviewed native cost of each complete augmented authority port, not a
 * guessed per-read increment or a quota reservation. These owners require an
 * explicit new ceiling because review adds native requests to the old grants. */
export type FinancialSettlementAuthorityCeilings = Readonly<{ caseClassClinicalExpiry?: number; resend?: number }>;
type Failure = Readonly<{ kind: "unavailable" }>;
const limit = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 1 && Number(n) <= 180;
const messageContext = (q: FinancialMessageQuery) => ({ intent: q.sources.intent.intent,
  intentRecallRef: q.binding.intentRecallRef, targetRef: q.sources.booking.observation.targetRef });

/** The returned real consumer grants keep every independent source, provider,
 * patient, recipient, clinical and producer/restore authority. Concrete invoice
 * and optional waiver reads constrain only their own consequences. Receipt
 * delivery keeps its original grants; known outcomes and replay rules stay in
 * the existing effect owners. Construction starts no consumer or provider I/O. */
function bindFinancialSettlementAuthorities(independent: FinancialConsumerAuthorities, review: ClinikoFinancialSettlementReview,
  ceilings: FinancialSettlementAuthorityCeilings = {}): Result<FinancialConsumerAuthorities, Failure> {
  try {
    if (!(review instanceof ClinikoFinancialSettlementReview) ||
        independent.caseClassClinicalExpiry && (!limit(ceilings.caseClassClinicalExpiry) || ceilings.caseClassClinicalExpiry <= independent.caseClassClinicalExpiry.maximumAuthorityRequests) ||
        independent.resend && (!limit(ceilings.resend) || ceilings.resend <= independent.resend.maximumAuthorityRequests)) return err({ kind: "unavailable" });
    const checkout = independent.checkout, message = independent.message, expiry = independent.checkoutExpiry, resend = independent.resend?.authority;
    const checkoutGrant = checkout.collectionAuthorized.bind(checkout), checkoutCurrent = checkout.current.bind(checkout);
    const messageGrant = message.messageAuthorized.bind(message), messageCurrent = message.current.bind(message);
    const clinical = <T, A extends FinancialExpiryApproval>(authority: FinancialExpiryAuthority<T, A>): FinancialExpiryAuthority<T, A> => {
      const grant = authority.financialAuthorized.bind(authority), current = authority.current.bind(authority);
      return Object.freeze({ sources: authority.sources, referenceAuthorized: authority.referenceAuthorized.bind(authority),
        providerBindingAuthorized: authority.providerBindingAuthorized.bind(authority), producerAdmitted: authority.producerAdmitted.bind(authority),
        clinicalApproval: authority.clinicalApproval.bind(authority), current,
        financialAuthorized: (q: Parameters<typeof grant>[0], signal: AbortSignal) => review.allows({ intent: q.sources.intent.intent, intentRecallRef: q.binding.intentRecallRef,
          targetRef: q.sources.booking.observation.targetRef }, "cancelClinical", signal, () => grant(q, signal), () => current(q, signal)) });
    };
    const expiryGrant = expiry?.expiryAuthorized.bind(expiry), expiryCurrent = expiry?.current.bind(expiry);
    const resendGrant = resend?.financialAuthorized.bind(resend), resendCurrent = resend?.current.bind(resend);
    return ok(Object.freeze({ ...independent,
      checkout: Object.freeze({ attemptScanAuthorized: checkout.attemptScanAuthorized.bind(checkout), sourceAuthorized: checkout.sourceAuthorized.bind(checkout),
        producerAdmitted: checkout.producerAdmitted.bind(checkout), current: checkoutCurrent,
        collectionAuthorized: (q: Parameters<typeof checkoutGrant>[0], signal: AbortSignal) => review.allows({ intent: q.intent, intentRecallRef: q.intentRecallRef, targetRef: q.targetRef },
          "collect", signal, () => checkoutGrant(q, signal), () => checkoutCurrent(q, signal)) }),
      message: Object.freeze({ sourceAuthorized: message.sourceAuthorized.bind(message), attemptScanAuthorized: message.attemptScanAuthorized.bind(message),
        providerBindingAuthorized: message.providerBindingAuthorized.bind(message), producerAdmitted: message.producerAdmitted.bind(message), current: messageCurrent,
        messageAuthorized: (q: FinancialMessageQuery, signal: AbortSignal) => q.message.purpose === "receiptDelivery" ? messageGrant(q, signal)
          : review.allows(messageContext(q), "sendLink", signal, () => messageGrant(q, signal), () => messageCurrent(q, signal)) }),
      ...(expiry ? { checkoutExpiry: Object.freeze({ sources: expiry.sources, referenceAuthorized: expiry.referenceAuthorized.bind(expiry),
        providerBindingAuthorized: expiry.providerBindingAuthorized.bind(expiry), producerAdmitted: expiry.producerAdmitted.bind(expiry), current: expiryCurrent!,
        expiryAuthorized: (q: Parameters<NonNullable<typeof expiryGrant>>[0], signal: AbortSignal) => review.allows({ intent: q.sources.intent.intent, intentRecallRef: q.binding.intentRecallRef,
          targetRef: q.sources.booking.observation.targetRef }, "expireCheckout", signal, () => expiryGrant!(q, signal), () => expiryCurrent!(q, signal)) }) } : {}),
      ...(independent.clinicalExpiry ? { clinicalExpiry: clinical(independent.clinicalExpiry) } : {}),
      ...(independent.classClinicalExpiry ? { classClinicalExpiry: Object.freeze({ ...independent.classClinicalExpiry,
        authority: clinical(independent.classClinicalExpiry.authority) }) } : {}),
      ...(independent.caseClassClinicalExpiry ? { caseClassClinicalExpiry: Object.freeze({ ...independent.caseClassClinicalExpiry,
        maximumAuthorityRequests: ceilings.caseClassClinicalExpiry!, authority: clinical(independent.caseClassClinicalExpiry.authority) }) } : {}),
      ...(independent.resend ? { resend: Object.freeze({ maximumAuthorityRequests: ceilings.resend!,
        authority: Object.freeze({ allows: resend!.allows.bind(resend), current: resendCurrent!,
          financialAuthorized: (q: Parameters<NonNullable<typeof resendGrant>>[0], signal: AbortSignal) => q.message.purpose === "receiptDelivery" ? resendGrant!(q, signal)
            : review.allows(messageContext(q), "sendLink", signal, () => resendGrant!(q, signal), () => resendCurrent!(q, signal)) }) }) } : {}),
    }));
  } catch { return err({ kind: "unavailable" }); }
}

/** Construct the actual consumer with one checked physical native budget.
 * This fits the existing explicit serving provision; it starts no background
 * work and still needs all independent current clinic/effect/restore grants. */
export function createFinancialSettlementConsumer(config: FinancialConsumerConfig, independent: FinancialConsumerAuthorities,
  review: ClinikoFinancialSettlementReview, dependencies: Parameters<typeof ClinikoFinancialConsumer.create>[2],
  ceilings: FinancialSettlementAuthorityCeilings = {}): Result<ClinikoFinancialConsumer, Failure> {
  try {
    const captured = Object.freeze({ ...config, webhook: Object.freeze({ ...config.webhook }),
      checkout: Object.freeze({ ...config.checkout, stripe: Object.freeze({ ...config.checkout.stripe }),
        cliniko: Object.freeze({ ...config.checkout.cliniko, scope: Object.freeze({ ...config.checkout.cliniko.scope }),
          stripe: Object.freeze({ ...config.checkout.cliniko.stripe }), producer: Object.freeze({ ...config.checkout.cliniko.producer }) }) }) });
    if (!(review instanceof ClinikoFinancialSettlementReview) || !review.matches(captured.checkout.cliniko)) return err({ kind: "unavailable" });
    const grants = bindFinancialSettlementAuthorities(independent, review, ceilings);
    if (!grants.ok) return grants;
    const consumer = ClinikoFinancialConsumer.create(captured, grants.value, dependencies);
    return consumer.ok ? consumer : err({ kind: "unavailable" });
  } catch { return err({ kind: "unavailable" }); }
}
