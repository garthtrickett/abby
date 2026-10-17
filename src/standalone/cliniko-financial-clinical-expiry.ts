import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { ClinikoCancellationWriter } from "../cliniko/appointment-write.ts";
import type { ClinikoAppointmentTarget, ClinikoCancellationRequest } from "../cliniko/appointment-write.ts";
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

export type FinancialClinicalReferenceQuery = Readonly<{
  purpose: "inspectFinancialClinicalExpiry"; ownerBinding: string; binding: FinancialLifecycleBinding; sources: FinancialLifecycleSources;
}>;
export type FinancialClinicalExpiryQuery = Readonly<{
  purpose: "cancelUnpaidFinancialBooking"; ownerBinding: string; binding: FinancialLifecycleBinding;
  sources: FinancialLifecycleSources; correlation: StripeCheckoutExpiryContext; money: StripeCheckoutEvidence; target: ClinikoAppointmentTarget;
}>;
/** Independent current clinic permission for this cancellation consequence,
 * never inferred from a terms version, a deadline or a Stripe unpaid result. */
export type FinancialClinicalApproval = Readonly<{
  kind: "cancelUnpaidIndividual"; policyVersion: string; termsVersion: string;
  approvedTerms: string; timeZone: string; cancellationReason: ClinikoCancellationRequest["cancellationReason"];
}>;
export type FinancialClinicalExpiryAuthority = Readonly<{
  sources: FinancialLifecycleSourceAuthority;
  referenceAuthorized(query: FinancialClinicalReferenceQuery, signal: AbortSignal): Promise<boolean>;
  providerBindingAuthorized(query: FinancialClinicalExpiryQuery, signal: AbortSignal): Promise<boolean>;
  /** Current native/manual paid and waiver review, fees and financial authority.
   * Missing/incomplete evidence must refuse even when Stripe is closed-unpaid. */
  financialAuthorized(query: FinancialClinicalExpiryQuery, signal: AbortSignal): Promise<boolean>;
  clinicalApproval(query: FinancialClinicalExpiryQuery, signal: AbortSignal): Promise<FinancialClinicalApproval | null>;
  producerAdmitted(query: FinancialClinicalExpiryQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialClinicalReferenceQuery | FinancialClinicalExpiryQuery, signal: AbortSignal): boolean;
}>;
export type FinancialClinicalExpiryConfig = Readonly<{ cliniko: FinancialRecordRetentionConfig; stripe: StripeReadConfig; deadlineMs?: number }>;
export type FinancialClinicalExpiryOutcome = Readonly<{ kind: "cancelled" | "uncertain"; money: StripeCheckoutEvidence["kind"] | "unknown"; reviewRequired: boolean }>;
type FailureKind = "invalidConfig" | "invalidQuery" | "forbidden" | "mismatched" | "alreadyClaimed" | "attemptUncertain" | "unavailable";
export type FinancialClinicalExpiryFailure = Readonly<{ kind: FailureKind }>;
class Failure extends Error { constructor(readonly kind: FailureKind) { super(kind); } }
type Prepared = Readonly<{ query: FinancialClinicalExpiryQuery; approval: FinancialClinicalApproval; request: ClinikoCancellationRequest; payloadDigest: string }>;
function data(q: FinancialClinicalExpiryQuery) {
  const { observedAt: _correlationTime, ...correlation } = q.correlation;
  const { observedAt: _moneyTime, ...money } = q.money;
  return { sources: financialLifecycleSourceData(q.sources), target: q.target, correlation, money };
}

/** One independently authorized individual cancellation after closed-unpaid
 * evidence. The dedicated native possible-expiry review precedes transport.
 * Class/case/pass operations, replay, refunds and restoration are not supplied. */
export class ClinikoFinancialClinicalExpiryOwner {
  readonly #config: FinancialClinicalExpiryConfig;
  readonly #authority: FinancialClinicalExpiryAuthority;
  readonly #barrier: FinancialEffectBarrier;
  readonly #binding: string;
  readonly #sources: FinancialLifecycleSourceReader;
  readonly #correlation: StripeCheckoutCorrelationReader;
  readonly #money: StripeCheckoutReader;
  readonly #writer: ClinikoCancellationWriter;
  private constructor(config: FinancialClinicalExpiryConfig, authority: FinancialClinicalExpiryAuthority, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, binding: string, native: typeof fetch, stripe: typeof fetch) {
    this.#config = Object.freeze({ ...config, cliniko: Object.freeze({ ...config.cliniko }), stripe: Object.freeze({ ...config.stripe }) });
    this.#authority = Object.freeze({ sources: authority.sources, referenceAuthorized: authority.referenceAuthorized.bind(authority),
      providerBindingAuthorized: authority.providerBindingAuthorized.bind(authority), financialAuthorized: authority.financialAuthorized.bind(authority),
      clinicalApproval: authority.clinicalApproval.bind(authority), producerAdmitted: authority.producerAdmitted.bind(authority), current: authority.current.bind(authority) });
    this.#barrier = Object.freeze({ matches: barrier.matches.bind(barrier), claimOnce: barrier.claimOnce.bind(barrier) }); this.#binding = binding;
    this.#sources = new FinancialLifecycleSourceReader(config.cliniko, authority.sources, records, barrier, native);
    this.#correlation = new StripeCheckoutCorrelationReader(config.stripe, stripe); this.#money = new StripeCheckoutReader(config.stripe, stripe);
    const writer = ClinikoCancellationWriter.create(config.cliniko, native, () => this.#now());
    if (!writer.ok) throw new Failure("invalidConfig"); this.#writer = writer.value;
  }
  static create(config: FinancialClinicalExpiryConfig, authority: FinancialClinicalExpiryAuthority, records: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<ClinikoFinancialClinicalExpiryOwner, FinancialClinicalExpiryFailure> {
    try {
      const binding = financialRecordOwnerBinding(config?.cliniko);
      if (!binding.ok || config.stripe.accountRef !== config.cliniko.stripe.accountRef || config.stripe.livemode !== config.cliniko.stripe.livemode ||
          config.stripe.apiVersion !== "2025-06-30.basil" || config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 30_000) ||
          [authority?.referenceAuthorized, authority?.providerBindingAuthorized, authority?.financialAuthorized, authority?.clinicalApproval, authority?.producerAdmitted, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoFinancialClinicalExpiryOwner(config, authority, records, barrier, binding.value, native, stripe));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #now(): string {
    const now = this.#config.cliniko.clock?.() ?? new Date().toISOString();
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Failure("unavailable"); return now;
  }
  #current(q: FinancialClinicalReferenceQuery | FinancialClinicalExpiryQuery, signal: AbortSignal): void {
    const now = Date.parse(this.#now());
    if (signal.aborted || this.#barrier.matches(q.sources.intent.intent.scope, this.#binding) !== true || this.#authority.current(q, signal) !== true ||
        now < Date.parse(q.sources.intent.intent.payment.deadline) || now >= Date.parse(q.sources.intent.intent.booking.startsAt)) throw new Failure("forbidden");
  }
  async #referencePermit(q: FinancialClinicalReferenceQuery, op: FinancialLifecycleOperation): Promise<void> {
    if (await op.wait(Promise.resolve().then(() => this.#authority.referenceAuthorized(q, op.signal))) !== true) throw new Failure("forbidden"); this.#current(q, op.signal);
  }
  async #query(b: FinancialLifecycleBinding, op: FinancialLifecycleOperation): Promise<FinancialClinicalExpiryQuery> {
    const sources = await this.#sources.read(b, "clinicalExpiry", op), i = sources.intent.intent;
    // Neither a class association nor the individual cancellation writer may
    // stand in for the class/case/pass cancellation owner's separate contract.
    const id = /^cliniko:appointment:([1-9][0-9]{0,18})$/.exec(sources.booking.observation.targetRef)?.[1];
    if (i.booking.kind !== "book" || !id || !sources.booking.observation.financialConsent || Date.parse(sources.booking.observation.observedAt) > Date.parse(this.#now()) + 30_000) throw new Failure("forbidden");
    const reference = freezeFinancialContext({ purpose: "inspectFinancialClinicalExpiry" as const, ownerBinding: this.#binding, binding: b, sources });
    await this.#referencePermit(reference, op);
    const correlation = await op.wait(this.#correlation.readExpiry(b.checkoutRef, op.signal));
    await this.#referencePermit(reference, op);
    if (!correlation.ok) throw new Failure("unavailable");
    const c = correlation.value, a = sources.creation.attempt;
    if (c.financialActionRef !== i.actionRef || c.effectRef !== i.effects.checkout || c.intentDigest !== financialIntentDigest(i) ||
        c.amount !== i.payment.amount || c.currency !== i.payment.currency || c.expiresAt !== i.payment.deadline ||
        c.created < a.createdFrom || c.created > a.createdThrough || c.status !== "expired" || Math.abs(Date.parse(c.observedAt) - Date.parse(this.#now())) > 30_000) throw new Failure("mismatched");
    const money = await op.wait(this.#money.inspect({ checkoutRef: b.checkoutRef, actionRef: i.actionRef, amount: i.payment.amount, currency: i.payment.currency }, op.signal));
    await this.#referencePermit(reference, op);
    if (!money.ok || money.value.kind !== "unpaid" || !money.value.paymentClosed || money.value.status !== "expired") throw new Failure("forbidden");
    const target: ClinikoAppointmentTarget = freezeFinancialContext({ scope: i.scope, patientId: i.patientId, appointmentId: id,
      practitionerId: i.booking.practitionerId, appointmentTypeId: i.booking.appointmentTypeId, startsAt: i.booking.startsAt, endsAt: i.booking.endsAt });
    const observed = await op.wait(this.#writer.observe(target, op.signal));
    await this.#referencePermit(reference, op);
    if (!observed.ok || observed.value.kind !== "active") throw new Failure("mismatched");
    return freezeFinancialContext({ purpose: "cancelUnpaidFinancialBooking", ownerBinding: this.#binding, binding: b, sources, correlation: c, money: money.value, target });
  }
  async #prepare(q: FinancialClinicalExpiryQuery, op: FinancialLifecycleOperation): Promise<Prepared> {
    for (const grant of [this.#authority.providerBindingAuthorized, this.#authority.financialAuthorized, this.#authority.producerAdmitted]) {
      if (await op.wait(Promise.resolve().then(() => grant(q, op.signal))) !== true) throw new Failure("forbidden"); this.#current(q, op.signal);
    }
    const incoming = await op.wait(Promise.resolve().then(() => this.#authority.clinicalApproval(q, op.signal)));
    this.#current(q, op.signal);
    if (!incoming || Object.keys(incoming).sort().join(",") !== "approvedTerms,cancellationReason,kind,policyVersion,termsVersion,timeZone" ||
        incoming.kind !== "cancelUnpaidIndividual" || incoming.policyVersion !== q.sources.intent.intent.payment.policyVersion ||
        incoming.termsVersion !== q.sources.intent.intent.payment.termsVersion || typeof incoming.approvedTerms !== "string" ||
        !incoming.approvedTerms.trim() || incoming.approvedTerms.length > 1_200 || typeof incoming.timeZone !== "string" || !incoming.timeZone || incoming.timeZone.length > 128 ||
        ![10, 20, 30, 40, 50, 60].includes(incoming.cancellationReason)) throw new Failure("forbidden");
    const approval = freezeFinancialContext(structuredClone(incoming));
    const segments = financialConsentReadback(q.sources.intent.intent, approval.approvedTerms, approval.timeZone);
    const consent = q.sources.booking.observation.financialConsent!;
    if (!segments || financialConsentDigest(segments) !== consent.presentationDigest || consent.playedAt < q.sources.intent.intent.createdAt ||
        consent.acceptedAt < consent.playedAt || consent.acceptedAt > q.sources.booking.observation.observedAt ||
        Date.parse(consent.acceptedAt) > Date.parse(this.#now())) throw new Failure("forbidden");
    const request = freezeFinancialContext({ ...q.target, cancellationReason: approval.cancellationReason });
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
      const value = await awaitUntilAbort(task, signal); if (value === undefined || signal.aborted || performance.now() - began > deadline) throw new Failure("unavailable"); return value;
    } };
    let dispatched = false, cancelled = false;
    try {
      const prepared = await this.#prepare(await this.#query(b, op), op), q = prepared.query;
      const history = await this.#sources.history(b, "clinicalExpiry", q.sources, this.#now(), op), effect = q.sources.intent.intent.effects.clinicalExpiry;
      if (history.expiryAttempts?.some(a => a.attempt.effectRef === effect || a.attempt.financialActionRef === b.financialActionRef && a.attempt.purpose === "clinicalExpiry")) throw new Failure("alreadyClaimed");
      const renewed = await this.#prepare(q, op);
      if (!isDeepStrictEqual(prepared, renewed)) throw new Failure("mismatched");
      const attempt: FinancialExpiryAttempt = freezeFinancialContext({ actionRef: randomUUID(), financialActionRef: b.financialActionRef, effectRef: effect, purpose: "clinicalExpiry",
        intentRecallRef: b.intentRecallRef, intentDigest: financialIntentDigest(q.sources.intent.intent)!, observationRecallRef: b.observationRecallRef,
        observationActionRef: b.observationActionRef, targetRef: q.sources.booking.observation.targetRef, checkoutRef: b.checkoutRef,
        payloadDigest: prepared.payloadDigest, attemptedAt: this.#now() });
      if (!encodeFinancialExpiryAttempt(attempt).ok) throw new Failure("invalidQuery"); this.#current(q, signal);
      const claimed = await op.wait(this.#barrier.claimOnce(effect));
      if (!claimed.ok || !claimed.value.claimed) throw new Failure(claimed.ok ? "alreadyClaimed" : "unavailable");
      const permitted = await this.#prepare(q, op);
      if (!isDeepStrictEqual(prepared, permitted)) throw new Failure("mismatched");
      const retained = await op.wait(this.#sources.records.retainExpiryAttemptOnce(attempt, { intent: q.sources.intent.intent, intentRecallRef: b.intentRecallRef,
        observationRecallRef: b.observationRecallRef, observation: q.sources.booking.observation }, q.sources.intent.recallAt, signal));
      if (!retained.ok || retained.value.kind !== "accepted") throw new Failure("attemptUncertain");
      const final = await this.#prepare(await this.#query(b, op), op);
      if (!isDeepStrictEqual(data(q), data(final.query)) || !isDeepStrictEqual(prepared.approval, final.approval) || prepared.payloadDigest !== final.payloadDigest) throw new Failure("mismatched");
      const exact = await op.wait(this.#sources.records.readExpiryAttempt({ recallRef: retained.value.recallRef, actionRef: attempt.actionRef, intentRecallRef: b.intentRecallRef }, final.query.sources.intent.intent, signal));
      if (!exact.ok || exact.value.recalled || exact.value.archivedAt !== null || !isDeepStrictEqual(exact.value.attempt, attempt)) throw new Failure("mismatched");
      const outcome = await this.#writer.cancelOnce(final.request, signal, async edgeSignal => {
        const edge: FinancialLifecycleOperation = { signal: edgeSignal, wait: async <T>(task: Promise<T>) => {
          const value = await awaitUntilAbort(task, edgeSignal); if (value === undefined || edgeSignal.aborted || performance.now() - began > deadline) throw new Failure("unavailable"); return value;
        } };
        // This runs after the cancellation writer's last target read/budget wait.
        const ready = await this.#prepare(await this.#query(b, edge), edge);
        if (!isDeepStrictEqual(data(final.query), data(ready.query)) || ready.payloadDigest !== prepared.payloadDigest) return false;
        const retainedAgain = await edge.wait(this.#sources.records.readExpiryAttempt({ recallRef: retained.value.recallRef, actionRef: attempt.actionRef, intentRecallRef: b.intentRecallRef }, ready.query.sources.intent.intent, edgeSignal));
        if (!retainedAgain.ok || retainedAgain.value.recalled || retainedAgain.value.archivedAt !== null || !isDeepStrictEqual(retainedAgain.value.attempt, attempt)) return false;
        const approvedAgain = await this.#prepare(ready.query, edge);
        if (approvedAgain.payloadDigest !== prepared.payloadDigest) return false;
        this.#current(ready.query, edgeSignal); if (performance.now() - began > deadline) return false;
        dispatched = true; return true;
      });
      if (!dispatched) throw new Failure("forbidden");
      cancelled = outcome.ok && outcome.value.kind === "cancelled";
      const reference = freezeFinancialContext({ purpose: "inspectFinancialClinicalExpiry" as const, ownerBinding: this.#binding, binding: b, sources: final.query.sources });
      await this.#referencePermit(reference, op);
      const money = await op.wait(this.#money.inspect({ checkoutRef: b.checkoutRef, actionRef: b.financialActionRef,
        amount: q.sources.intent.intent.payment.amount, currency: q.sources.intent.intent.payment.currency }, signal));
      await this.#referencePermit(reference, op);
      const unpaid = money.ok && money.value.kind === "unpaid" && money.value.paymentClosed;
      return ok({ kind: cancelled ? "cancelled" : "uncertain", money: money.ok ? money.value.kind : "unknown", reviewRequired: !cancelled || !unpaid });
    } catch (error) {
      return dispatched ? ok({ kind: cancelled ? "cancelled" : "uncertain", money: "unknown", reviewRequired: true })
        : err({ kind: error instanceof Failure ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
