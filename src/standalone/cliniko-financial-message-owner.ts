import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoFinancialReviewReader } from "../cliniko/financial-review-read.ts";
import type { ClinikoFinancialReviewContext, ClinikoFinancialReviewSelection } from "../cliniko/financial-review-read.ts";
import { ClinikoFinancialRecordRetainer, financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialBookingObservationContext, FinancialRecordRetentionConfig, FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import type { FinancialCheckoutAttempt } from "../cliniko/financial-checkout-attempt.ts";
import { financialIntentDigest } from "../cliniko/financial-booking-observation.ts";
import { ClinikoFinancialWorkDiscovery } from "../cliniko/financial-work-discovery.ts";
import type { FinancialDiscoveryAccountQuery } from "../cliniko/financial-work-discovery.ts";
import { encodeFinancialMessageAttempt } from "../cliniko/financial-message-attempt.ts";
import type { FinancialMessageAttempt, FinancialMessagePurpose } from "../cliniko/financial-message-attempt.ts";
import { financialSelection } from "../cliniko/internal/financial-record-context.ts";
import { validRecallMarker } from "../cliniko/recall-note.ts";
import { StripeCheckoutCorrelationReader } from "../stripe/checkout-correlation.ts";
import type { StripeCheckoutCorrelation, StripeCheckoutLinkContext } from "../stripe/checkout-correlation.ts";
import { StripeCheckoutReader } from "../stripe/checkout-read.ts";
import type { StripeCheckoutEvidence } from "../stripe/checkout-read.ts";
import type { StripeReadConfig, StripeReadFailure } from "../stripe/internal/api-read.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import { financialMessageDigest, validFinancialMessageSelection } from "./smtp-financial-message-delivery.ts";
import type { FinancialMail, FinancialMessageDelivery, FinancialMessageSelection } from "./smtp-financial-message-delivery.ts";

export type FinancialMessageBinding = Readonly<{
  intentRecallRef: string; financialActionRef: string; observationRecallRef: string; observationActionRef: string;
  checkoutAttemptRecallRef: string; checkoutAttemptActionRef: string; checkoutRef: string;
}>;
type Sources = Readonly<{ intent: ClinikoFinancialReviewContext; booking: FinancialBookingObservationContext;
  creation: Readonly<{ recallRef: string; recalled: boolean; archivedAt: string | null; attempt: FinancialCheckoutAttempt }> }>;
export type FinancialMessageSourceQuery = ClinikoFinancialReviewSelection & Readonly<{
  purpose: "financialMessageSource"; ownerBinding: string; binding: FinancialMessageBinding;
  record: Readonly<{ recallRef: string; actionRef: string; includeArchived: boolean }>;
}>;
export type FinancialMessageQuery = ClinikoFinancialReviewSelection & Readonly<{
  purpose: "financialMessageDelivery"; ownerBinding: string; binding: FinancialMessageBinding;
  effectRef: string; sources: Sources; correlation: StripeCheckoutCorrelation | StripeCheckoutLinkContext;
  money: StripeCheckoutEvidence; selection: FinancialMessageSelection; message: FinancialMail; payloadDigest: string;
}>;
/** Independently provisioned financial service grants. Provider binding approval
 * must establish that the exact Session belongs to this obligation independently
 * of mutable metadata. Producer/restore admission covers ALL prior senders and
 * complete permanent effect history; notes, local absence or lease expiry are
 * never substitutes. Message authorization also requires the current native
 * recipient and approved sender/template/purpose; an old intent is insufficient.
 * These ports check authority, not perform effects. */
export type FinancialMessageAuthority = Readonly<{
  sourceAuthorized(query: FinancialMessageSourceQuery, signal: AbortSignal): Promise<boolean>;
  attemptScanAuthorized(query: FinancialDiscoveryAccountQuery, signal: AbortSignal): Promise<boolean>;
  providerBindingAuthorized(query: FinancialMessageQuery, signal: AbortSignal): Promise<boolean>;
  messageAuthorized(query: FinancialMessageQuery, signal: AbortSignal): Promise<boolean>;
  producerAdmitted(query: FinancialMessageQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialMessageSourceQuery | FinancialMessageQuery | FinancialDiscoveryAccountQuery, signal: AbortSignal): boolean;
}>;
export type FinancialMessageOwnerConfig = Readonly<{ cliniko: FinancialRecordRetentionConfig; stripe: StripeReadConfig; deadlineMs?: number }>;
export type FinancialMessageFailure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "unavailable" | "mismatched" | "alreadyClaimed" | "attemptUncertain" }>;
export type FinancialMessageOutcome = Readonly<{ kind: "accepted" | "definitiveUnsent" | "unknown" }>;
class Failure extends Error { readonly kind: FinancialMessageFailure["kind"]; constructor(kind: FinancialMessageFailure["kind"]) { super("Financial message unavailable"); this.kind = kind; } }
function frozen<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function sourceData(s: Sources) { const { observedAt: _readAt, ...intent } = s.intent; return { ...s, intent }; }
function providerData(q: FinancialMessageQuery) {
  const { observedAt: _readAt, ...correlation } = q.correlation, { observedAt: _moneyReadAt, ...money } = q.money;
  return { correlation, money, message: q.message, payloadDigest: q.payloadDigest };
}
type Operation = Readonly<{ signal: AbortSignal; wait<T>(task: Promise<T>): Promise<T>; current(q: FinancialMessageSourceQuery | FinancialMessageQuery | FinancialDiscoveryAccountQuery): void }>;

/** One-use private message owner. No caller proof, webhook flag, receipt link,
 * record, claim or SMTP result is promoted to money/clinical permission. */
export class ClinikoFinancialMessageOwner {
  readonly #config: FinancialMessageOwnerConfig;
  readonly #selection: ClinikoFinancialReviewSelection;
  readonly #binding: string;
  readonly #authority: FinancialMessageAuthority;
  readonly #records: ClinikoFinancialRecordRetainer;
  readonly #barrier: FinancialEffectBarrier;
  readonly #delivery: FinancialMessageDelivery;
  readonly #messageSelection: FinancialMessageSelection;
  readonly #native: typeof fetch;
  readonly #correlation: StripeCheckoutCorrelationReader;
  readonly #money: StripeCheckoutReader;
  private constructor(config: FinancialMessageOwnerConfig, authority: FinancialMessageAuthority, records: ClinikoFinancialRecordRetainer,
    barrier: FinancialEffectBarrier, delivery: FinancialMessageDelivery, selection: FinancialMessageSelection, binding: string, native: typeof fetch, stripe: typeof fetch) {
    this.#selection = financialSelection(config.cliniko); this.#config = Object.freeze({ ...config, cliniko: Object.freeze({ ...config.cliniko,
      scope: this.#selection.scope, stripe: this.#selection.stripe, producer: Object.freeze({ ...config.cliniko.producer }) }), stripe: Object.freeze({ ...config.stripe }) });
    this.#binding = binding; this.#records = records; this.#native = native; this.#messageSelection = frozen(structuredClone(selection));
    this.#barrier = Object.freeze({ matches: barrier.matches.bind(barrier), claimOnce: barrier.claimOnce.bind(barrier) });
    this.#delivery = Object.freeze({ selection: delivery.selection.bind(delivery), send: delivery.send.bind(delivery) });
    this.#authority = Object.freeze({ sourceAuthorized: authority.sourceAuthorized.bind(authority), attemptScanAuthorized: authority.attemptScanAuthorized.bind(authority),
      providerBindingAuthorized: authority.providerBindingAuthorized.bind(authority), messageAuthorized: authority.messageAuthorized.bind(authority),
      producerAdmitted: authority.producerAdmitted.bind(authority), current: authority.current.bind(authority) });
    this.#correlation = new StripeCheckoutCorrelationReader(config.stripe, stripe); this.#money = new StripeCheckoutReader(config.stripe, stripe);
  }
  static create(config: FinancialMessageOwnerConfig, authority: FinancialMessageAuthority, recordsAuthority: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, delivery: FinancialMessageDelivery, native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<ClinikoFinancialMessageOwner, FinancialMessageFailure> {
    try {
      const binding = financialRecordOwnerBinding(config?.cliniko), selection = delivery?.selection();
      if (!binding.ok || config.stripe.accountRef !== config.cliniko.stripe.accountRef || config.stripe.livemode !== config.cliniko.stripe.livemode ||
          config.stripe.apiVersion !== "2025-06-30.basil" || !validFinancialMessageSelection(selection) || typeof delivery.send !== "function" ||
          config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 30_000) ||
          [authority?.sourceAuthorized, authority?.attemptScanAuthorized, authority?.providerBindingAuthorized, authority?.messageAuthorized,
            authority?.producerAdmitted, authority?.current].some(port => typeof port !== "function")) return err({ kind: "invalidConfig" });
      const records = ClinikoFinancialRecordRetainer.create(config.cliniko, recordsAuthority, barrier, native);
      return records.ok ? ok(new ClinikoFinancialMessageOwner(config, authority, records.value, barrier, delivery, selection, binding.value, native, stripe)) : err({ kind: "invalidConfig" });
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #sourceQuery(binding: FinancialMessageBinding, recallRef: string, actionRef: string, includeArchived = false): FinancialMessageSourceQuery {
    return frozen({ ...this.#selection, purpose: "financialMessageSource", ownerBinding: this.#binding, binding, record: { recallRef, actionRef, includeArchived } });
  }
  async #sourcePermit(q: FinancialMessageSourceQuery, op: Operation): Promise<boolean> {
    if (await op.wait(Promise.resolve().then(() => this.#authority.sourceAuthorized(q, op.signal))) !== true) throw new Failure("forbidden");
    op.current(q); return true;
  }
  async #sources(b: FinancialMessageBinding, op: Operation): Promise<Sources> {
    const query = this.#sourceQuery(b, b.intentRecallRef, b.financialActionRef);
    const reader = ClinikoFinancialReviewReader.create(this.#config.cliniko, { allows: async q => {
      if (q.recallRef !== b.intentRecallRef || q.actionRef !== b.financialActionRef || q.includeArchived) return false;
      return this.#sourcePermit(query, op);
    } }, this.#native);
    if (!reader.ok) throw new Failure("invalidConfig");
    const intent = await op.wait(reader.value.read({ recallRef: b.intentRecallRef, actionRef: b.financialActionRef }, op.signal));
    if (!intent.ok || intent.value.recalled || intent.value.archivedAt !== null) throw new Failure("forbidden");
    const bookingGrant = this.#sourceQuery(b, b.observationRecallRef, b.observationActionRef); await this.#sourcePermit(bookingGrant, op);
    const booking = await op.wait(this.#records.readBookingObservation({ recallRef: b.observationRecallRef,
      actionRef: b.observationActionRef, intentRecallRef: b.intentRecallRef }, intent.value.intent, op.signal));
    await this.#sourcePermit(bookingGrant, op);
    if (!booking.ok || booking.value.recalled || booking.value.archivedAt !== null ||
        Date.parse(booking.value.observation.observedAt) > Date.parse(this.#now()) + 30_000) throw new Failure("mismatched");
    const creationGrant = this.#sourceQuery(b, b.checkoutAttemptRecallRef, b.checkoutAttemptActionRef); await this.#sourcePermit(creationGrant, op);
    const creation = await op.wait(this.#records.readCheckoutAttempt({ recallRef: b.checkoutAttemptRecallRef,
      actionRef: b.checkoutAttemptActionRef, intentRecallRef: b.intentRecallRef }, intent.value.intent, op.signal));
    await this.#sourcePermit(creationGrant, op);
    if (!creation.ok || creation.value.recalled || creation.value.archivedAt !== null ||
        creation.value.attempt.actionRef !== b.checkoutAttemptActionRef || creation.value.attempt.observationRecallRef !== b.observationRecallRef ||
        creation.value.attempt.observationActionRef !== b.observationActionRef || creation.value.attempt.targetRef !== booking.value.observation.targetRef) throw new Failure("mismatched");
    await this.#sourcePermit(query, op);
    return { intent: intent.value, booking: booking.value, creation: creation.value };
  }
  #now(): string {
    const now = this.#config.cliniko.clock?.() ?? new Date().toISOString();
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new Failure("unavailable");
    return now;
  }
  async #query(b: FinancialMessageBinding, sources: Sources, purpose: FinancialMessagePurpose, op: Operation): Promise<FinancialMessageQuery> {
    const i = sources.intent.intent, a = sources.creation.attempt;
    const correlated = await op.wait<Result<StripeCheckoutCorrelation | StripeCheckoutLinkContext, StripeReadFailure>>(
      purpose === "linkDelivery" ? this.#correlation.readLink(b.checkoutRef, op.signal) : this.#correlation.read(b.checkoutRef, op.signal));
    if (!correlated.ok) throw new Failure("unavailable");
    const c = correlated.value;
    if (c.financialActionRef !== i.actionRef || c.accountRef !== i.stripe.accountRef || c.livemode !== i.stripe.livemode ||
        c.effectRef !== i.effects.checkout || c.effectRef !== a.effectRef || c.intentDigest !== financialIntentDigest(i) || c.intentDigest !== a.intentDigest ||
        c.amount !== i.payment.amount || c.currency !== i.payment.currency || c.created < a.createdFrom || c.created > a.createdThrough) throw new Failure("mismatched");
    const evidence = await op.wait(this.#money.inspect({ checkoutRef: b.checkoutRef, actionRef: i.actionRef,
      amount: i.payment.amount, currency: i.payment.currency }, op.signal));
    if (!evidence.ok) throw new Failure("unavailable");
    let message: FinancialMail;
    if (purpose === "linkDelivery") {
      if (c.kind !== "linkContext" || evidence.value.kind !== "unpaid" || evidence.value.status !== "open" ||
          c.expiresAt !== i.payment.deadline || Date.parse(i.payment.deadline) <= Date.parse(this.#now())) throw new Failure("forbidden");
      message = { purpose, email: i.recipient.address, amount: i.payment.amount, currency: i.payment.currency, url: c.url, deadline: i.payment.deadline };
    } else {
      if (evidence.value.kind !== "received" || evidence.value.receiptUrl === null) throw new Failure("forbidden");
      message = { purpose, email: i.recipient.address, amount: i.payment.amount, currency: i.payment.currency, url: evidence.value.receiptUrl };
    }
    const payloadDigest = financialMessageDigest(this.#messageSelection, message); if (!payloadDigest) throw new Failure("mismatched");
    return frozen({ ...this.#selection, purpose: "financialMessageDelivery", ownerBinding: this.#binding, binding: b,
      effectRef: i.effects[purpose], sources, correlation: c, money: evidence.value, selection: this.#messageSelection, message, payloadDigest });
  }
  async #permit(q: FinancialMessageQuery, op: Operation): Promise<void> {
    for (const grant of [this.#authority.providerBindingAuthorized, this.#authority.messageAuthorized, this.#authority.producerAdmitted]) {
      if (await op.wait(Promise.resolve().then(() => grant(q, op.signal))) !== true) throw new Failure("forbidden"); op.current(q);
    }
  }
  async #history(b: FinancialMessageBinding, q: FinancialMessageQuery, op: Operation): Promise<void> {
    const history = ClinikoFinancialWorkDiscovery.create(this.#config.cliniko, {
      allowsAccountRead: async account => {
        op.current(account); const allowed = await op.wait(this.#authority.attemptScanAuthorized(account, op.signal)); op.current(account); return allowed === true;
      },
      allowsRecordRead: record => this.#sourcePermit(this.#sourceQuery(b, record.recallRef, record.actionRef, true), op),
      current: record => { try { op.current("recallRef" in record ? this.#sourceQuery(b, record.recallRef, record.actionRef, true) : record); return true; } catch { return false; } },
    }, this.#native);
    if (!history.ok) throw new Failure("invalidConfig");
    const intent = q.sources.intent;
    const found = await op.wait(history.value.scanPatient({ patientId: intent.intent.patientId,
      createdFrom: new Date(Math.min(Date.parse(intent.intent.createdAt), Date.parse(intent.createdAt)) - 30_000).toISOString(),
      createdThrough: new Date(Date.parse(this.#now()) + 30_000).toISOString() }, op.signal));
    if (!found.ok) throw new Failure(found.error.kind === "forbidden" ? "forbidden" : "unavailable");
    if (found.value.messageAttempts?.some(row => row.attempt.effectRef === q.effectRef ||
        row.attempt.financialActionRef === intent.intent.actionRef && row.attempt.purpose === q.message.purpose)) throw new Failure("alreadyClaimed");
  }
  async sendOnce(binding: FinancialMessageBinding, purpose: FinancialMessagePurpose, external: AbortSignal): Promise<Result<FinancialMessageOutcome, FinancialMessageFailure>> {
    let b: FinancialMessageBinding;
    try {
      b = frozen(structuredClone(binding));
      if (!b || Object.keys(b).sort().join(",") !== "checkoutAttemptActionRef,checkoutAttemptRecallRef,checkoutRef,financialActionRef,intentRecallRef,observationActionRef,observationRecallRef" ||
          !["linkDelivery", "receiptDelivery"].includes(purpose) ||
          ![b.intentRecallRef, b.observationRecallRef, b.checkoutAttemptRecallRef].every(v => typeof v === "string" && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v)) ||
          new Set([b.intentRecallRef, b.observationRecallRef, b.checkoutAttemptRecallRef]).size !== 3 ||
          ![b.financialActionRef, b.observationActionRef, b.checkoutAttemptActionRef].every(validRecallMarker) ||
          new Set([b.financialActionRef, b.observationActionRef, b.checkoutAttemptActionRef]).size !== 3 ||
          typeof b.checkoutRef !== "string" || !/^cs_(?:test_|live_)?[A-Za-z0-9]{1,200}$/.test(b.checkoutRef)) return err({ kind: "invalidQuery" });
    } catch { return err({ kind: "invalidQuery" }); }
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadlineMs = this.#config.deadlineMs ?? 30_000, began = performance.now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs), signal = AbortSignal.any([external, controller.signal]);
    const active = () => !signal.aborted && performance.now() - began <= deadlineMs;
    const op: Operation = { signal, wait: async <T>(task: Promise<T>) => {
      const value = await awaitUntilAbort(task, signal); if (value === undefined || !active()) throw new Failure("unavailable"); return value;
    }, current: q => {
      if (!active() || this.#barrier.matches(this.#selection.scope, this.#binding) !== true ||
          !isDeepStrictEqual(this.#delivery.selection(), this.#messageSelection) || this.#authority.current(q, signal) !== true || !active()) throw new Failure("forbidden");
    } };
    let dispatched = false;
    try {
      const sources = await this.#sources(b, op), query = await this.#query(b, sources, purpose, op);
      await this.#permit(query, op); await this.#history(b, query, op); await this.#permit(query, op);
      const attempt: FinancialMessageAttempt = frozen({ actionRef: randomUUID(), financialActionRef: b.financialActionRef,
        effectRef: query.effectRef, purpose, intentRecallRef: b.intentRecallRef, intentDigest: financialIntentDigest(sources.intent.intent)!,
        observationRecallRef: b.observationRecallRef, observationActionRef: b.observationActionRef, targetRef: sources.booking.observation.targetRef,
        checkoutRef: b.checkoutRef, payloadDigest: query.payloadDigest, attemptedAt: this.#now() });
      if (!encodeFinancialMessageAttempt(attempt).ok) throw new Failure("invalidQuery");
      op.current(query);
      const claim = await op.wait(this.#barrier.claimOnce(query.effectRef));
      if (claim?.ok !== true || claim.value?.claimed !== true) throw new Failure(claim?.ok === true && claim.value?.claimed === false ? "alreadyClaimed" : "unavailable");
      await this.#permit(query, op);
      const retained = await op.wait(this.#records.retainMessageAttemptOnce(attempt, { intent: sources.intent.intent,
        intentRecallRef: b.intentRecallRef, observationRecallRef: b.observationRecallRef, observation: sources.booking.observation }, sources.intent.recallAt, signal));
      if (!retained.ok || retained.value.kind !== "accepted") throw new Failure("attemptUncertain");
      const freshSources = await this.#sources(b, op), fresh = await this.#query(b, freshSources, purpose, op);
      if (!isDeepStrictEqual(sourceData(freshSources), sourceData(sources)) || !isDeepStrictEqual(providerData(fresh), providerData(query))) throw new Failure("mismatched");
      const exactAttempt = await op.wait(this.#records.readMessageAttempt({ recallRef: retained.value.recallRef, actionRef: attempt.actionRef,
        intentRecallRef: b.intentRecallRef }, freshSources.intent.intent, signal));
      if (!exactAttempt.ok || exactAttempt.value.recalled || exactAttempt.value.archivedAt !== null ||
          !isDeepStrictEqual(exactAttempt.value.attempt, attempt)) throw new Failure("mismatched");
      await this.#permit(fresh, op); op.current(fresh);
      dispatched = true;
      const sent = await awaitUntilAbort(Promise.resolve().then(() => this.#delivery.send(fresh.message, signal, fresh.effectRef)), signal);
      // An observed SMTP acceptance cannot be erased by a later observer/role
      // failure. Only this fixed outcome escapes; no private source/ref/URL does.
      if (sent?.kind === "accepted" && sent.messageRef === fresh.effectRef) return ok({ kind: "accepted" });
      return ok({ kind: sent?.kind === "definitiveUnsent" ? "definitiveUnsent" : "unknown" });
    } catch (error) {
      return dispatched ? ok({ kind: "unknown" }) : err({ kind: error instanceof Failure ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
