import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { financialIntentDigest } from "../cliniko/financial-booking-observation.ts";
import { encodeFinancialExpiryAttempt } from "../cliniko/financial-expiry-attempt.ts";
import type { FinancialExpiryAttempt } from "../cliniko/financial-expiry-attempt.ts";
import { financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordRetentionConfig, FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import { StripeCheckoutCorrelationReader } from "../stripe/checkout-correlation.ts";
import type { StripeCheckoutExpiryContext } from "../stripe/checkout-correlation.ts";
import { StripeCheckoutReader } from "../stripe/checkout-read.ts";
import type { StripeCheckoutEvidence } from "../stripe/checkout-read.ts";
import type { StripeReadConfig } from "../stripe/internal/api-read.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import { FinancialLifecycleSourceReader, financialLifecycleSourceData, freezeFinancialContext, validFinancialLifecycleBinding } from "./financial-lifecycle-sources.ts";
import type { FinancialLifecycleBinding, FinancialLifecycleSources, FinancialLifecycleSourceAuthority, FinancialLifecycleOperation } from "./financial-lifecycle-sources.ts";
import { financialConsentReadback, financialConsentDigest } from "./financial-consent-readback.ts";
import type { ClinikoBudgetDenial } from "../cliniko/read-budget.ts";

export type FinancialClinicalReferenceQuery = Readonly<{
  purpose: "inspectFinancialClinicalExpiry"; ownerBinding: string; binding: FinancialLifecycleBinding; sources: FinancialLifecycleSources;
}>;
export type FinancialExpiryQuery<Target> = Readonly<{
  purpose: "cancelUnpaidFinancialBooking"; ownerBinding: string; binding: FinancialLifecycleBinding;
  sources: FinancialLifecycleSources; correlation: StripeCheckoutExpiryContext; money: StripeCheckoutEvidence; target: Target;
}>;
/** Independent current clinic permission for this cancellation consequence,
 * never inferred from a terms version, a deadline or a Stripe unpaid result. */
export type FinancialExpiryApproval = Readonly<{
  kind: string; policyVersion: string; termsVersion: string;
  approvedTerms: string; timeZone: string; cancellationReason: number;
}>;
export type FinancialExpiryAuthority<Target, Approval extends FinancialExpiryApproval> = Readonly<{
  sources: FinancialLifecycleSourceAuthority;
  referenceAuthorized(query: FinancialClinicalReferenceQuery, signal: AbortSignal): Promise<boolean>;
  providerBindingAuthorized(query: FinancialExpiryQuery<Target>, signal: AbortSignal): Promise<boolean>;
  /** Current native/manual paid and waiver review, fees and financial authority.
   * Missing/incomplete evidence must refuse even when Stripe is closed-unpaid. */
  financialAuthorized(query: FinancialExpiryQuery<Target>, signal: AbortSignal): Promise<boolean>;
  clinicalApproval(query: FinancialExpiryQuery<Target>, signal: AbortSignal): Promise<Approval | null>;
  producerAdmitted(query: FinancialExpiryQuery<Target>, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialClinicalReferenceQuery | FinancialExpiryQuery<Target>, signal: AbortSignal): boolean;
}>;
export type FinancialClinicalExpiryConfig = Readonly<{ cliniko: FinancialRecordRetentionConfig; stripe: StripeReadConfig; deadlineMs?: number }>;
export type FinancialClinicalExpiryOutcome = Readonly<{ kind: "cancelled" | "uncertain"; money: StripeCheckoutEvidence["kind"] | "unknown"; reviewRequired: boolean }>;
type FailureKind = "invalidConfig" | "invalidQuery" | "forbidden" | "mismatched" | "alreadyClaimed" | "attemptUncertain" | "unavailable";
export type FinancialClinicalExpiryFailure = Readonly<{ kind: FailureKind }> |
  Readonly<{ kind: "rateLimited"; retryAfterMs: number }>;
export class FinancialClinicalExpiryRefusal extends Error { readonly kind: FailureKind; constructor(kind: FailureKind) { super("Clinical expiry unavailable"); this.kind = kind; } }
type Prepared<Target, Approval, Request> = Readonly<{ query: FinancialExpiryQuery<Target>; approval: Approval; request: Request; payloadDigest: string }>;
/** Internal native strategy. Concrete owners construct it; callers and notes
 * cannot supply native truth or turn read authority into cancellation authority. */
export type FinancialClinicalTarget<Target, Approval extends FinancialExpiryApproval, Request> = Readonly<{
  beforeClaim?(target: Target, op: FinancialLifecycleOperation): Promise<ClinikoBudgetDenial | null>;
  read(sources: FinancialLifecycleSources, op: FinancialLifecycleOperation, permit: () => Promise<void>): Promise<Target>;
  request(target: Target, approval: Approval): Request | undefined;
  cancelOnce(request: Request, signal: AbortSignal, beforeSend: (signal: AbortSignal) => Promise<boolean>, afterSendRead: (signal: AbortSignal) => Promise<boolean>):
    Promise<Result<Readonly<{ kind: "cancelled" | "uncertain"; reviewRequired?: boolean }>, unknown>>;
}>;
function data<Target>(q: FinancialExpiryQuery<Target>) {
  const { observedAt: _correlationTime, ...correlation } = q.correlation;
  const { observedAt: _moneyTime, ...money } = q.money;
  return { sources: financialLifecycleSourceData(q.sources), target: q.target, correlation, money };
}

/** Shared one-use financial expiry protocol. Native owners retain their own
 * target, permission and cancellation inspection contracts. Money and native
 * possible-attempt retention never provide clinical authority. */
export class FinancialClinicalExpiryProtocol<Target, Approval extends FinancialExpiryApproval, Request> {
  readonly #config: FinancialClinicalExpiryConfig;
  readonly #authority: FinancialExpiryAuthority<Target, Approval>;
  readonly #barrier: FinancialEffectBarrier;
  readonly #binding: string;
  readonly #sources: FinancialLifecycleSourceReader;
  readonly #correlation: StripeCheckoutCorrelationReader;
  readonly #money: StripeCheckoutReader;
  readonly #nativeTarget: FinancialClinicalTarget<Target, Approval, Request>;
  private constructor(config: FinancialClinicalExpiryConfig, authority: FinancialExpiryAuthority<Target, Approval>, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, binding: string, native: typeof fetch, stripe: typeof fetch, nativeTarget: FinancialClinicalTarget<Target, Approval, Request>) {
    this.#config = Object.freeze({ ...config, cliniko: Object.freeze({ ...config.cliniko }), stripe: Object.freeze({ ...config.stripe }) });
    this.#authority = Object.freeze({ sources: authority.sources, referenceAuthorized: authority.referenceAuthorized.bind(authority),
      providerBindingAuthorized: authority.providerBindingAuthorized.bind(authority), financialAuthorized: authority.financialAuthorized.bind(authority),
      clinicalApproval: authority.clinicalApproval.bind(authority), producerAdmitted: authority.producerAdmitted.bind(authority), current: authority.current.bind(authority) });
    this.#barrier = Object.freeze({ matches: barrier.matches.bind(barrier), claimOnce: barrier.claimOnce.bind(barrier) }); this.#binding = binding;
    this.#sources = new FinancialLifecycleSourceReader(config.cliniko, authority.sources, records, barrier, native);
    this.#correlation = new StripeCheckoutCorrelationReader(config.stripe, stripe); this.#money = new StripeCheckoutReader(config.stripe, stripe);
    this.#nativeTarget = Object.freeze({ ...(nativeTarget.beforeClaim ? { beforeClaim: nativeTarget.beforeClaim.bind(nativeTarget) } : {}), read: nativeTarget.read.bind(nativeTarget), request: nativeTarget.request.bind(nativeTarget), cancelOnce: nativeTarget.cancelOnce.bind(nativeTarget) });
  }
  static create<Target, Approval extends FinancialExpiryApproval, Request>(config: FinancialClinicalExpiryConfig, authority: FinancialExpiryAuthority<Target, Approval>, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, native: typeof fetch, stripe: typeof fetch, nativeTarget: FinancialClinicalTarget<Target, Approval, Request>): Result<FinancialClinicalExpiryProtocol<Target, Approval, Request>, FinancialClinicalExpiryFailure> {
    try {
      const binding = financialRecordOwnerBinding(config?.cliniko);
      if (!binding.ok || config.stripe.accountRef !== config.cliniko.stripe.accountRef || config.stripe.livemode !== config.cliniko.stripe.livemode ||
          config.stripe.apiVersion !== "2025-06-30.basil" || config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 30_000) ||
          [authority?.referenceAuthorized, authority?.providerBindingAuthorized, authority?.financialAuthorized, authority?.clinicalApproval, authority?.producerAdmitted, authority?.current, nativeTarget?.read, nativeTarget?.request, nativeTarget?.cancelOnce].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new FinancialClinicalExpiryProtocol<Target, Approval, Request>(config, authority, records, barrier, binding.value, native, stripe, nativeTarget));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #now(): string {
    const now = this.#config.cliniko.clock?.() ?? new Date().toISOString();
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new FinancialClinicalExpiryRefusal("unavailable"); return now;
  }
  #current(q: FinancialClinicalReferenceQuery | FinancialExpiryQuery<Target>, signal: AbortSignal): void {
    const now = Date.parse(this.#now());
    if (signal.aborted || this.#barrier.matches(q.sources.intent.intent.scope, this.#binding) !== true || this.#authority.current(q, signal) !== true ||
        now < Date.parse(q.sources.intent.intent.payment.deadline) || now >= Date.parse(q.sources.intent.intent.booking.startsAt)) throw new FinancialClinicalExpiryRefusal("forbidden");
  }
  async #referencePermit(q: FinancialClinicalReferenceQuery, op: FinancialLifecycleOperation): Promise<void> {
    if (await op.wait(Promise.resolve().then(() => this.#authority.referenceAuthorized(q, op.signal))) !== true) throw new FinancialClinicalExpiryRefusal("forbidden"); this.#current(q, op.signal);
  }
  async #query(b: FinancialLifecycleBinding, op: FinancialLifecycleOperation): Promise<FinancialExpiryQuery<Target>> {
    const sources = await this.#sources.read(b, "clinicalExpiry", op), i = sources.intent.intent;
    if (!sources.booking.observation.financialConsent || Date.parse(sources.booking.observation.observedAt) > Date.parse(this.#now()) + 30_000) throw new FinancialClinicalExpiryRefusal("forbidden");
    const reference = freezeFinancialContext({ purpose: "inspectFinancialClinicalExpiry" as const, ownerBinding: this.#binding, binding: b, sources });
    await this.#referencePermit(reference, op);
    const correlation = await op.wait(this.#correlation.readExpiry(b.checkoutRef, op.signal));
    await this.#referencePermit(reference, op);
    if (!correlation.ok) throw new FinancialClinicalExpiryRefusal("unavailable");
    const c = correlation.value, a = sources.creation.attempt;
    if (c.financialActionRef !== i.actionRef || c.effectRef !== i.effects.checkout || c.intentDigest !== financialIntentDigest(i) ||
        c.amount !== i.payment.amount || c.currency !== i.payment.currency || c.expiresAt !== i.payment.deadline ||
        c.created < a.createdFrom || c.created > a.createdThrough || c.status !== "expired" || Math.abs(Date.parse(c.observedAt) - Date.parse(this.#now())) > 30_000) throw new FinancialClinicalExpiryRefusal("mismatched");
    const money = await op.wait(this.#money.inspect({ checkoutRef: b.checkoutRef, actionRef: i.actionRef, amount: i.payment.amount, currency: i.payment.currency }, op.signal));
    await this.#referencePermit(reference, op);
    if (!money.ok || money.value.kind !== "unpaid" || !money.value.paymentClosed || money.value.status !== "expired") throw new FinancialClinicalExpiryRefusal("forbidden");
    const target = await op.wait(this.#nativeTarget.read(sources, op, () => this.#referencePermit(reference, op)));
    await this.#referencePermit(reference, op);
    return freezeFinancialContext({ purpose: "cancelUnpaidFinancialBooking", ownerBinding: this.#binding, binding: b, sources, correlation: c, money: money.value, target });
  }
  async #prepare(q: FinancialExpiryQuery<Target>, op: FinancialLifecycleOperation): Promise<Prepared<Target, Approval, Request>> {
    for (const grant of [this.#authority.providerBindingAuthorized, this.#authority.financialAuthorized, this.#authority.producerAdmitted]) {
      if (await op.wait(Promise.resolve().then(() => grant(q, op.signal))) !== true) throw new FinancialClinicalExpiryRefusal("forbidden"); this.#current(q, op.signal);
    }
    const incoming = await op.wait(Promise.resolve().then(() => this.#authority.clinicalApproval(q, op.signal)));
    this.#current(q, op.signal);
    if (!incoming || incoming.policyVersion !== q.sources.intent.intent.payment.policyVersion ||
        incoming.termsVersion !== q.sources.intent.intent.payment.termsVersion || typeof incoming.approvedTerms !== "string" ||
        !incoming.approvedTerms.trim() || incoming.approvedTerms.length > 1_200 || typeof incoming.timeZone !== "string" || !incoming.timeZone || incoming.timeZone.length > 128 ||
        ![10, 20, 30, 40, 50, 60].includes(incoming.cancellationReason)) throw new FinancialClinicalExpiryRefusal("forbidden");
    const approval = freezeFinancialContext(structuredClone(incoming));
    const segments = financialConsentReadback(q.sources.intent.intent, approval.approvedTerms, approval.timeZone);
    const consent = q.sources.booking.observation.financialConsent!;
    if (!segments || financialConsentDigest(segments) !== consent.presentationDigest || consent.playedAt < q.sources.intent.intent.createdAt ||
        consent.acceptedAt < consent.playedAt || consent.acceptedAt > q.sources.booking.observation.observedAt ||
        Date.parse(consent.acceptedAt) > Date.parse(this.#now())) throw new FinancialClinicalExpiryRefusal("forbidden");
    const nativeRequest = this.#nativeTarget.request(q.target, approval);
    if (nativeRequest === undefined) throw new FinancialClinicalExpiryRefusal("forbidden");
    const request = freezeFinancialContext(nativeRequest);
    const payloadDigest = createHash("sha256").update(JSON.stringify(["abby.financial-clinical-expiry.v1", financialIntentDigest(q.sources.intent.intent),
      q.binding.checkoutRef, q.sources.intent.intent.effects.clinicalExpiry, request, approval, consent])).digest("hex");
    return freezeFinancialContext({ query: q, approval, request, payloadDigest });
  }
  async expireOnce(input: FinancialLifecycleBinding, external: AbortSignal): Promise<Result<FinancialClinicalExpiryOutcome, FinancialClinicalExpiryFailure>> {
    let b: FinancialLifecycleBinding;
    try { b = freezeFinancialContext(structuredClone(input)); if (!validFinancialLifecycleBinding(b)) return err({ kind: "invalidQuery" }); }
    catch { return err({ kind: "invalidQuery" }); }
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const controller = new AbortController(), deadline = this.#config.deadlineMs ?? 30_000, began = performance.now();
    const timer = setTimeout(() => controller.abort(), deadline), signal = AbortSignal.any([external, controller.signal]);
    const op: FinancialLifecycleOperation = { signal, wait: async <T>(task: Promise<T>) => {
      const value = await awaitUntilAbort(task, signal); if (value === undefined || signal.aborted || performance.now() - began > deadline) throw new FinancialClinicalExpiryRefusal("unavailable"); return value;
    } };
    let dispatched = false, cancelled = false;
    try {
      const prepared = await this.#prepare(await this.#query(b, op), op), q = prepared.query;
      const history = await this.#sources.history(b, "clinicalExpiry", q.sources, this.#now(), op), effect = q.sources.intent.intent.effects.clinicalExpiry;
      if (history.expiryAttempts?.some(a => a.attempt.effectRef === effect || a.attempt.financialActionRef === b.financialActionRef && a.attempt.purpose === "clinicalExpiry")) throw new FinancialClinicalExpiryRefusal("alreadyClaimed");
      const renewed = await this.#prepare(q, op);
      if (!isDeepStrictEqual(prepared, renewed)) throw new FinancialClinicalExpiryRefusal("mismatched");
      if (this.#nativeTarget.beforeClaim) {
        const denied = await op.wait(this.#nativeTarget.beforeClaim(q.target, op));
        if (denied !== null) {
          const retry = denied.kind === "rateLimited" ? denied.retryAfterMs : undefined;
          // Retry timing is returned only before the irreversible effect claim.
          // Malformed admission and any later attempt keep their refusal rules.
          if (typeof retry === "number" && Number.isSafeInteger(retry) && retry > 0 && retry <= 8_640_000_000)
            return err({ kind: "rateLimited", retryAfterMs: retry });
          throw new FinancialClinicalExpiryRefusal("unavailable");
        }
      }
      const attempt: FinancialExpiryAttempt = freezeFinancialContext({ actionRef: randomUUID(), financialActionRef: b.financialActionRef, effectRef: effect, purpose: "clinicalExpiry",
        intentRecallRef: b.intentRecallRef, intentDigest: financialIntentDigest(q.sources.intent.intent)!, observationRecallRef: b.observationRecallRef,
        observationActionRef: b.observationActionRef, targetRef: q.sources.booking.observation.targetRef, checkoutRef: b.checkoutRef,
        payloadDigest: prepared.payloadDigest, attemptedAt: this.#now() });
      if (!encodeFinancialExpiryAttempt(attempt).ok) throw new FinancialClinicalExpiryRefusal("invalidQuery"); this.#current(q, signal);
      const claimed = await op.wait(this.#barrier.claimOnce(effect));
      if (!claimed.ok || !claimed.value.claimed) throw new FinancialClinicalExpiryRefusal(claimed.ok ? "alreadyClaimed" : "unavailable");
      const permitted = await this.#prepare(q, op);
      if (!isDeepStrictEqual(prepared, permitted)) throw new FinancialClinicalExpiryRefusal("mismatched");
      const retained = await op.wait(this.#sources.records.retainExpiryAttemptOnce(attempt, { intent: q.sources.intent.intent, intentRecallRef: b.intentRecallRef,
        observationRecallRef: b.observationRecallRef, observation: q.sources.booking.observation }, q.sources.intent.recallAt, signal));
      if (!retained.ok || retained.value.kind !== "accepted") throw new FinancialClinicalExpiryRefusal("attemptUncertain");
      const attemptRecallRef = retained.value.recallRef;
      const final = await this.#prepare(await this.#query(b, op), op);
      if (!isDeepStrictEqual(data(q), data(final.query)) || !isDeepStrictEqual(prepared.approval, final.approval) || prepared.payloadDigest !== final.payloadDigest) throw new FinancialClinicalExpiryRefusal("mismatched");
      const exact = await op.wait(this.#sources.records.readExpiryAttempt({ recallRef: attemptRecallRef, actionRef: attempt.actionRef, intentRecallRef: b.intentRecallRef }, final.query.sources.intent.intent, signal));
      if (!exact.ok || exact.value.recalled || exact.value.archivedAt !== null || !isDeepStrictEqual(exact.value.attempt, attempt)) throw new FinancialClinicalExpiryRefusal("mismatched");
      const outcome = await this.#nativeTarget.cancelOnce(final.request, signal, async edgeSignal => {
        const edge: FinancialLifecycleOperation = { signal: edgeSignal, wait: async <T>(task: Promise<T>) => {
          const value = await awaitUntilAbort(task, edgeSignal); if (value === undefined || edgeSignal.aborted || performance.now() - began > deadline) throw new FinancialClinicalExpiryRefusal("unavailable"); return value;
        } };
        // This runs after the cancellation writer's last target read/budget wait.
        const ready = await this.#prepare(await this.#query(b, edge), edge);
        if (!isDeepStrictEqual(data(final.query), data(ready.query)) || ready.payloadDigest !== prepared.payloadDigest) return false;
        const retainedAgain = await edge.wait(this.#sources.records.readExpiryAttempt({ recallRef: attemptRecallRef, actionRef: attempt.actionRef, intentRecallRef: b.intentRecallRef }, ready.query.sources.intent.intent, edgeSignal));
        if (!retainedAgain.ok || retainedAgain.value.recalled || retainedAgain.value.archivedAt !== null || !isDeepStrictEqual(retainedAgain.value.attempt, attempt)) return false;
        const approvedAgain = await this.#prepare(ready.query, edge);
        if (approvedAgain.payloadDigest !== prepared.payloadDigest) return false;
        this.#current(ready.query, edgeSignal); if (performance.now() - began > deadline) return false;
        dispatched = true; return true;
      }, async readSignal => {
        const read: FinancialLifecycleOperation = { signal: readSignal, wait: async <T>(task: Promise<T>) => {
          const value = await awaitUntilAbort(task, readSignal);
          if (value === undefined || readSignal.aborted || performance.now() - began > deadline) throw new FinancialClinicalExpiryRefusal("unavailable");
          return value;
        } };
        await this.#referencePermit(freezeFinancialContext({ purpose: "inspectFinancialClinicalExpiry" as const,
          ownerBinding: this.#binding, binding: b, sources: final.query.sources }), read);
        return true;
      });
      if (!dispatched) throw new FinancialClinicalExpiryRefusal("forbidden");
      cancelled = outcome.ok && outcome.value.kind === "cancelled";
      const reference = freezeFinancialContext({ purpose: "inspectFinancialClinicalExpiry" as const, ownerBinding: this.#binding, binding: b, sources: final.query.sources });
      await this.#referencePermit(reference, op);
      const money = await op.wait(this.#money.inspect({ checkoutRef: b.checkoutRef, actionRef: b.financialActionRef,
        amount: q.sources.intent.intent.payment.amount, currency: q.sources.intent.intent.payment.currency }, signal));
      await this.#referencePermit(reference, op);
      const unpaid = money.ok && money.value.kind === "unpaid" && money.value.paymentClosed;
      const nativeReview = outcome.ok && outcome.value.reviewRequired === true;
      return ok({ kind: cancelled ? "cancelled" : "uncertain", money: money.ok ? money.value.kind : "unknown", reviewRequired: !cancelled || nativeReview || !unpaid });
    } catch (error) {
      return dispatched ? ok({ kind: cancelled ? "cancelled" : "uncertain", money: "unknown", reviewRequired: true })
        : err({ kind: error instanceof FinancialClinicalExpiryRefusal ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
