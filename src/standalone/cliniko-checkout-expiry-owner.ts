import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { financialIntentDigest } from "../cliniko/financial-booking-observation.ts";
import { financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordRetentionConfig, FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import type { FinancialExpiryAttempt } from "../cliniko/financial-expiry-attempt.ts";
import { encodeFinancialExpiryAttempt } from "../cliniko/financial-expiry-attempt.ts";
import { StripeCheckoutCorrelationReader } from "../stripe/checkout-correlation.ts";
import type { StripeCheckoutExpiryContext } from "../stripe/checkout-correlation.ts";
import { StripeCheckoutReader } from "../stripe/checkout-read.ts";
import type { StripeCheckoutEvidence } from "../stripe/checkout-read.ts";
import { StripeCheckoutExpirer } from "../stripe/checkout-expire.ts";
import type { StripeReadConfig } from "../stripe/internal/api-read.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import { FinancialLifecycleSourceReader, financialLifecycleSourceData, freezeFinancialContext, validFinancialLifecycleBinding } from "./financial-lifecycle-sources.ts";
import type { FinancialLifecycleBinding, FinancialLifecycleSources, FinancialLifecycleSourceAuthority, FinancialLifecycleOperation } from "./financial-lifecycle-sources.ts";

export type CheckoutExpiryReferenceQuery = Readonly<{
  purpose: "inspectFinancialCheckoutExpiry"; ownerBinding: string; binding: FinancialLifecycleBinding; sources: FinancialLifecycleSources;
}>;
export type CheckoutExpiryQuery = Readonly<{
  purpose: "expireFinancialCheckout"; ownerBinding: string; binding: FinancialLifecycleBinding;
  sources: FinancialLifecycleSources; correlation: StripeCheckoutExpiryContext; money: StripeCheckoutEvidence; payloadDigest: string;
}>;
/** Current clinic financial authority must check the exact captured deadline,
 * fee/policy/terms and independent manual-payment/waiver status. An unpaid
 * Stripe Session alone, a webhook or ended caller proof cannot supply it.
 * Provider binding is independently established, not mutable metadata approval.
 * Producer admission covers every old actor and complete restored claim history. */
export type CheckoutExpiryAuthority = Readonly<{
  sources: FinancialLifecycleSourceAuthority;
  /** Scope/subject/reference read grant only; not original creation evidence. */
  referenceAuthorized(query: CheckoutExpiryReferenceQuery, signal: AbortSignal): Promise<boolean>;
  providerBindingAuthorized(query: CheckoutExpiryQuery, signal: AbortSignal): Promise<boolean>;
  expiryAuthorized(query: CheckoutExpiryQuery, signal: AbortSignal): Promise<boolean>;
  producerAdmitted(query: CheckoutExpiryQuery, signal: AbortSignal): Promise<boolean>;
  current(query: CheckoutExpiryQuery | CheckoutExpiryReferenceQuery, signal: AbortSignal): boolean;
}>;
export type CheckoutExpiryConfig = Readonly<{ cliniko: FinancialRecordRetentionConfig; stripe: StripeReadConfig; deadlineMs?: number }>;
export type CheckoutExpiryMoney = "closedUnpaid" | "unpaid" | "pending" | "received" | "adjusted" | "unknown";
export type CheckoutExpiryOutcome = Readonly<{ kind: "observedClosed" | "expiryAcknowledged" | "uncertain"; money: CheckoutExpiryMoney }>;
export type CheckoutExpiryFailure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "unavailable" | "mismatched" | "alreadyClaimed" | "attemptUncertain" }>;
class Failure extends Error { readonly kind: CheckoutExpiryFailure["kind"]; constructor(kind: CheckoutExpiryFailure["kind"]) { super("Checkout expiry unavailable"); this.kind = kind; } }
function data(q: CheckoutExpiryQuery) {
  const { observedAt: _stripeAt, ...correlation } = q.correlation, { observedAt: _moneyAt, ...money } = q.money;
  return { sources: financialLifecycleSourceData(q.sources), correlation, money, payloadDigest: q.payloadDigest };
}
function moneyState(money: StripeCheckoutEvidence): CheckoutExpiryMoney {
  return money.kind === "unpaid" ? money.paymentClosed ? "closedUnpaid" : "unpaid" : money.kind;
}

/** One possible Checkout expiry, never direct PaymentIntent cancellation. The
 * fixed outcome separates an observed expiry ACK from fresh money inspection;
 * neither supplies permission to cancel or restore a clinical appointment. */
export class ClinikoCheckoutExpiryOwner {
  readonly #config: CheckoutExpiryConfig;
  readonly #authority: CheckoutExpiryAuthority;
  readonly #barrier: FinancialEffectBarrier;
  readonly #binding: string;
  readonly #sources: FinancialLifecycleSourceReader;
  readonly #correlation: StripeCheckoutCorrelationReader;
  readonly #money: StripeCheckoutReader;
  readonly #expiry: StripeCheckoutExpirer;
  private constructor(config: CheckoutExpiryConfig, authority: CheckoutExpiryAuthority, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, ownerBinding: string, native: typeof fetch, stripe: typeof fetch) {
    this.#config = Object.freeze({ ...config, cliniko: Object.freeze({ ...config.cliniko }), stripe: Object.freeze({ ...config.stripe }) });
    this.#authority = Object.freeze({ sources: authority.sources, referenceAuthorized: authority.referenceAuthorized.bind(authority), providerBindingAuthorized: authority.providerBindingAuthorized.bind(authority),
      expiryAuthorized: authority.expiryAuthorized.bind(authority), producerAdmitted: authority.producerAdmitted.bind(authority), current: authority.current.bind(authority) });
    this.#barrier = Object.freeze({ matches: barrier.matches.bind(barrier), claimOnce: barrier.claimOnce.bind(barrier) }); this.#binding = ownerBinding;
    this.#sources = new FinancialLifecycleSourceReader(config.cliniko, authority.sources, records, barrier, native);
    this.#correlation = new StripeCheckoutCorrelationReader(config.stripe, stripe); this.#money = new StripeCheckoutReader(config.stripe, stripe);
    this.#expiry = new StripeCheckoutExpirer(config.stripe, stripe);
  }
  static create(config: CheckoutExpiryConfig, authority: CheckoutExpiryAuthority, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<ClinikoCheckoutExpiryOwner, CheckoutExpiryFailure> {
    try {
      const binding = financialRecordOwnerBinding(config?.cliniko);
      if (!binding.ok || config.stripe.accountRef !== config.cliniko.stripe.accountRef || config.stripe.livemode !== config.cliniko.stripe.livemode ||
          config.stripe.apiVersion !== "2025-06-30.basil" || config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 30_000) ||
          [authority?.referenceAuthorized, authority?.providerBindingAuthorized, authority?.expiryAuthorized, authority?.producerAdmitted, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoCheckoutExpiryOwner(config, authority, records, barrier, binding.value, native, stripe));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #now(): string {
    const now = this.#config.cliniko.clock?.() ?? new Date().toISOString();
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Failure("unavailable"); return now;
  }
  #current(q: CheckoutExpiryQuery | CheckoutExpiryReferenceQuery, signal: AbortSignal): void {
    if (signal.aborted || this.#barrier.matches(q.sources.intent.intent.scope, this.#binding) !== true ||
        this.#authority.current(q, signal) !== true || Date.parse(this.#now()) < Date.parse(q.sources.intent.intent.payment.deadline)) throw new Failure("forbidden");
  }
  async #referencePermit(q: CheckoutExpiryReferenceQuery, op: FinancialLifecycleOperation): Promise<void> {
    if (await op.wait(Promise.resolve().then(() => this.#authority.referenceAuthorized(q, op.signal))) !== true) throw new Failure("forbidden");
    this.#current(q, op.signal);
  }
  async #permit(q: CheckoutExpiryQuery, op: FinancialLifecycleOperation): Promise<void> {
    for (const grant of [this.#authority.providerBindingAuthorized, this.#authority.expiryAuthorized, this.#authority.producerAdmitted]) {
      if (await op.wait(Promise.resolve().then(() => grant(q, op.signal))) !== true) throw new Failure("forbidden"); this.#current(q, op.signal);
    }
  }
  async #query(b: FinancialLifecycleBinding, op: FinancialLifecycleOperation): Promise<CheckoutExpiryQuery> {
    const sources = await this.#sources.read(b, "checkoutExpiry", op), i = sources.intent.intent, a = sources.creation.attempt;
    if (Date.parse(this.#now()) < Date.parse(i.payment.deadline) || Date.parse(sources.booking.observation.observedAt) > Date.parse(this.#now()) + 30_000) throw new Failure("forbidden");
    const reference = freezeFinancialContext({ purpose: "inspectFinancialCheckoutExpiry" as const, ownerBinding: this.#binding, binding: b, sources });
    await this.#referencePermit(reference, op);
    const correlation = await op.wait(this.#correlation.readExpiry(b.checkoutRef, op.signal));
    if (!correlation.ok) throw new Failure("unavailable");
    const c = correlation.value;
    if (c.financialActionRef !== i.actionRef || c.effectRef !== i.effects.checkout || c.intentDigest !== financialIntentDigest(i) ||
        c.amount !== i.payment.amount || c.currency !== i.payment.currency || c.expiresAt !== i.payment.deadline ||
        c.created < a.createdFrom || c.created > a.createdThrough || Math.abs(Date.parse(c.observedAt) - Date.parse(this.#now())) > 30_000) throw new Failure("mismatched");
    await this.#referencePermit(reference, op);
    const money = await op.wait(this.#money.inspect({ checkoutRef: b.checkoutRef, actionRef: i.actionRef, amount: i.payment.amount, currency: i.payment.currency }, op.signal));
    await this.#referencePermit(reference, op);
    if (!money.ok || money.value.status !== c.status) throw new Failure("mismatched");
    const payloadDigest = createHash("sha256").update(JSON.stringify(["abby.checkout-expiry.v1", b.checkoutRef, i.effects.checkoutExpiry,
      financialIntentDigest(i), c.accountRef, c.livemode, c.expiresAt])).digest("hex");
    return freezeFinancialContext({ purpose: "expireFinancialCheckout", ownerBinding: this.#binding, binding: b, sources, correlation: c, money: money.value, payloadDigest });
  }
  async expireOnce(input: FinancialLifecycleBinding, external: AbortSignal): Promise<Result<CheckoutExpiryOutcome, CheckoutExpiryFailure>> {
    let b: FinancialLifecycleBinding;
    try { b = freezeFinancialContext(structuredClone(input)); if (!validFinancialLifecycleBinding(b)) return err({ kind: "invalidQuery" }); }
    catch { return err({ kind: "invalidQuery" }); }
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const controller = new AbortController(), deadline = this.#config.deadlineMs ?? 30_000, began = performance.now();
    const timer = setTimeout(() => controller.abort(), deadline), signal = AbortSignal.any([external, controller.signal]);
    const op: FinancialLifecycleOperation = { signal, wait: async <T>(task: Promise<T>) => {
      const value = await awaitUntilAbort(task, signal); if (value === undefined || signal.aborted || performance.now() - began > deadline) throw new Failure("unavailable"); return value;
    } };
    let dispatched = false, acknowledged = false;
    try {
      const q = await this.#query(b, op); await this.#permit(q, op);
      if (q.money.kind === "unpaid" && q.money.paymentClosed) return ok({ kind: "observedClosed", money: "closedUnpaid" });
      if (q.money.kind !== "unpaid" || q.money.paymentClosed || q.money.status !== "open") throw new Failure("forbidden");
      const history = await this.#sources.history(b, "checkoutExpiry", q.sources, this.#now(), op), effect = q.sources.intent.intent.effects.checkoutExpiry;
      if (history.expiryAttempts?.some(a => a.attempt.effectRef === effect || a.attempt.financialActionRef === b.financialActionRef && a.attempt.purpose === "checkoutExpiry")) throw new Failure("alreadyClaimed");
      await this.#permit(q, op);
      const attempt: FinancialExpiryAttempt = freezeFinancialContext({ actionRef: randomUUID(), financialActionRef: b.financialActionRef, effectRef: effect,
        purpose: "checkoutExpiry", intentRecallRef: b.intentRecallRef, intentDigest: financialIntentDigest(q.sources.intent.intent)!, observationRecallRef: b.observationRecallRef,
        observationActionRef: b.observationActionRef, targetRef: q.sources.booking.observation.targetRef, checkoutRef: b.checkoutRef, payloadDigest: q.payloadDigest, attemptedAt: this.#now() });
      if (!encodeFinancialExpiryAttempt(attempt).ok) throw new Failure("invalidQuery"); this.#current(q, signal);
      const claimed = await op.wait(this.#barrier.claimOnce(effect));
      if (!claimed.ok || !claimed.value.claimed) throw new Failure(claimed.ok ? "alreadyClaimed" : "unavailable"); await this.#permit(q, op);
      const retained = await op.wait(this.#sources.records.retainExpiryAttemptOnce(attempt, { intent: q.sources.intent.intent, intentRecallRef: b.intentRecallRef,
        observationRecallRef: b.observationRecallRef, observation: q.sources.booking.observation }, q.sources.intent.recallAt, signal));
      if (!retained.ok || retained.value.kind !== "accepted") throw new Failure("attemptUncertain");
      const fresh = await this.#query(b, op);
      if (!isDeepStrictEqual(data(q), data(fresh))) throw new Failure("mismatched");
      const exact = await op.wait(this.#sources.records.readExpiryAttempt({ recallRef: retained.value.recallRef, actionRef: attempt.actionRef, intentRecallRef: b.intentRecallRef }, fresh.sources.intent.intent, signal));
      if (!exact.ok || exact.value.recalled || exact.value.archivedAt !== null || !isDeepStrictEqual(exact.value.attempt, attempt)) throw new Failure("mismatched");
      await this.#permit(fresh, op);
      const result = await this.#expiry.expire(fresh.correlation, effect, signal, () => {
        this.#current(fresh, signal); if (performance.now() - began > deadline) throw new Failure("unavailable"); dispatched = true;
      });
      acknowledged = result.kind === "acknowledged";
      if (!dispatched) throw new Failure("forbidden");
      // POST error/expiry ACK is not money proof. Observe independently after a
      // possible payment race; failure cannot erase the observed expiry ACK.
      const reference = freezeFinancialContext({ purpose: "inspectFinancialCheckoutExpiry" as const, ownerBinding: this.#binding, binding: b, sources: fresh.sources });
      await this.#referencePermit(reference, op);
      const money = await op.wait(this.#money.inspect({ checkoutRef: b.checkoutRef, actionRef: b.financialActionRef,
        amount: fresh.sources.intent.intent.payment.amount, currency: fresh.sources.intent.intent.payment.currency }, signal));
      await this.#referencePermit(reference, op);
      return ok({ kind: acknowledged ? "expiryAcknowledged" : "uncertain", money: money?.ok ? moneyState(money.value) : "unknown" });
    } catch (error) {
      return dispatched ? ok({ kind: acknowledged ? "expiryAcknowledged" : "uncertain", money: "unknown" })
        : err({ kind: error instanceof Failure ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
