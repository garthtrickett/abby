import type { FinancialResendContext } from "../cliniko/financial-resend-records.ts";
import type { FinancialDiscoveryResult } from "../cliniko/financial-work-discovery.ts";
import type { FinancialRecordRetention, FinancialRecordFailure } from "../cliniko/financial-record-retention.ts";
import { validFinancialEffectRef } from "./financial-effect-barrier.ts";
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
import type { FinancialMessagePurpose } from "../cliniko/financial-message-attempt.ts";
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
export type FinancialMessageSources = Readonly<{ intent: ClinikoFinancialReviewContext; booking: FinancialBookingObservationContext;
  creation: Readonly<{ recallRef: string; recalled: boolean; archivedAt: string | null; attempt: FinancialCheckoutAttempt }> }>;
export type FinancialMessageSourceQuery = ClinikoFinancialReviewSelection & Readonly<{
  purpose: "financialMessageSource"; ownerBinding: string; binding: FinancialMessageBinding;
  record: Readonly<{ recallRef: string; actionRef: string; includeArchived: boolean }>;
}>;
export type FinancialMessageQuery = ClinikoFinancialReviewSelection & Readonly<{
  purpose: "financialMessageDelivery"; ownerBinding: string; binding: FinancialMessageBinding;
  effectRef: string; resend?: FinancialResendContext; sources: FinancialMessageSources; correlation: StripeCheckoutCorrelation | StripeCheckoutLinkContext;
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
export class FinancialMessageProtocolRefusal extends Error { readonly kind: FinancialMessageFailure["kind"]; constructor(kind: FinancialMessageFailure["kind"]) { super("Financial message unavailable"); this.kind = kind; } }
function frozen<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function sourceData(s: FinancialMessageSources) { const { observedAt: _readAt, ...intent } = s.intent; return { ...s, intent }; }
function providerData(q: FinancialMessageQuery) {
  const { observedAt: _readAt, ...correlation } = q.correlation, { observedAt: _moneyReadAt, ...money } = q.money;
  return { correlation, money, message: q.message, payloadDigest: q.payloadDigest, ...(q.resend ? { resend: q.resend } : {}) };
}
export type FinancialMessageOperation = Readonly<{ signal: AbortSignal; wait<T>(task: Promise<T>): Promise<T>; current(q: FinancialMessageSourceQuery | FinancialMessageQuery | FinancialDiscoveryAccountQuery): void }>;

export type FinancialMessageAttemptPlan = Readonly<{
  retain(signal: AbortSignal): Promise<Result<FinancialRecordRetention, FinancialRecordFailure>>;
  matches(recallRef: string, signal: AbortSignal): Promise<boolean>;
}>;
/** Internal concrete-owner strategy. No remote caller may provide a strategy,
 * effect override, mutable record or grant in place of actual native checks. */
export type FinancialMessageMode = Readonly<{
  query(base: FinancialMessageQuery, op: FinancialMessageOperation): Promise<FinancialMessageQuery>;
  hasPrior(history: FinancialDiscoveryResult, query: FinancialMessageQuery): boolean;
  plan(query: FinancialMessageQuery, records: ClinikoFinancialRecordRetainer, at: string): FinancialMessageAttemptPlan | undefined;
  authorize?(query: FinancialMessageQuery, op: FinancialMessageOperation): Promise<boolean>;
  extraClaims?(query: FinancialMessageQuery): readonly string[];
  beforeClaim?(query: FinancialMessageQuery, op: FinancialMessageOperation): Promise<boolean>;
}>;

/** One-use private message owner. No caller proof, webhook flag, receipt link,
 * record, claim or SMTP result is promoted to money/clinical permission. */
export class FinancialMessageProtocol {
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
  readonly #mode: FinancialMessageMode;
  private constructor(config: FinancialMessageOwnerConfig, authority: FinancialMessageAuthority, records: ClinikoFinancialRecordRetainer,
    barrier: FinancialEffectBarrier, delivery: FinancialMessageDelivery, selection: FinancialMessageSelection, binding: string, mode: FinancialMessageMode, native: typeof fetch, stripe: typeof fetch) {
    this.#selection = financialSelection(config.cliniko); this.#config = Object.freeze({ ...config, cliniko: Object.freeze({ ...config.cliniko,
      scope: this.#selection.scope, stripe: this.#selection.stripe, producer: Object.freeze({ ...config.cliniko.producer }) }), stripe: Object.freeze({ ...config.stripe }) });
    this.#binding = binding; this.#records = records; this.#native = native; this.#messageSelection = frozen(structuredClone(selection));
    this.#barrier = Object.freeze({ matches: barrier.matches.bind(barrier), claimOnce: barrier.claimOnce.bind(barrier) });
    this.#delivery = Object.freeze({ selection: delivery.selection.bind(delivery), send: delivery.send.bind(delivery) });
    this.#authority = Object.freeze({ sourceAuthorized: authority.sourceAuthorized.bind(authority), attemptScanAuthorized: authority.attemptScanAuthorized.bind(authority),
      providerBindingAuthorized: authority.providerBindingAuthorized.bind(authority), messageAuthorized: authority.messageAuthorized.bind(authority),
      producerAdmitted: authority.producerAdmitted.bind(authority), current: authority.current.bind(authority) });
    this.#mode = Object.freeze({ query: mode.query.bind(mode), hasPrior: mode.hasPrior.bind(mode), plan: mode.plan.bind(mode),
      ...(mode.authorize ? { authorize: mode.authorize.bind(mode) } : {}), ...(mode.extraClaims ? { extraClaims: mode.extraClaims.bind(mode) } : {}),
      ...(mode.beforeClaim ? { beforeClaim: mode.beforeClaim.bind(mode) } : {}) });
    this.#correlation = new StripeCheckoutCorrelationReader(config.stripe, stripe); this.#money = new StripeCheckoutReader(config.stripe, stripe);
  }
  static create(config: FinancialMessageOwnerConfig, authority: FinancialMessageAuthority, recordsAuthority: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, delivery: FinancialMessageDelivery, mode: FinancialMessageMode, native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<FinancialMessageProtocol, FinancialMessageFailure> {
    try {
      const binding = financialRecordOwnerBinding(config?.cliniko), selection = delivery?.selection();
      if (!mode || [mode.query, mode.hasPrior, mode.plan].some(f => typeof f !== "function") || !binding.ok || config.stripe.accountRef !== config.cliniko.stripe.accountRef || config.stripe.livemode !== config.cliniko.stripe.livemode ||
          config.stripe.apiVersion !== "2025-06-30.basil" || !validFinancialMessageSelection(selection) || typeof delivery.send !== "function" ||
          config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 30_000) ||
          [authority?.sourceAuthorized, authority?.attemptScanAuthorized, authority?.providerBindingAuthorized, authority?.messageAuthorized,
            authority?.producerAdmitted, authority?.current].some(port => typeof port !== "function")) return err({ kind: "invalidConfig" });
      const records = ClinikoFinancialRecordRetainer.create(config.cliniko, recordsAuthority, barrier, native);
      return records.ok ? ok(new FinancialMessageProtocol(config, authority, records.value, barrier, delivery, selection, binding.value, mode, native, stripe)) : err({ kind: "invalidConfig" });
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #sourceQuery(binding: FinancialMessageBinding, recallRef: string, actionRef: string, includeArchived = false): FinancialMessageSourceQuery {
    return frozen({ ...this.#selection, purpose: "financialMessageSource", ownerBinding: this.#binding, binding, record: { recallRef, actionRef, includeArchived } });
  }
  async #sourcePermit(q: FinancialMessageSourceQuery, op: FinancialMessageOperation): Promise<boolean> {
    if (await op.wait(Promise.resolve().then(() => this.#authority.sourceAuthorized(q, op.signal))) !== true) throw new FinancialMessageProtocolRefusal("forbidden");
    op.current(q); return true;
  }
  async #sources(b: FinancialMessageBinding, op: FinancialMessageOperation): Promise<FinancialMessageSources> {
    const query = this.#sourceQuery(b, b.intentRecallRef, b.financialActionRef);
    const reader = ClinikoFinancialReviewReader.create(this.#config.cliniko, { allows: async q => {
      if (q.recallRef !== b.intentRecallRef || q.actionRef !== b.financialActionRef || q.includeArchived) return false;
      return this.#sourcePermit(query, op);
    } }, this.#native);
    if (!reader.ok) throw new FinancialMessageProtocolRefusal("invalidConfig");
    const intent = await op.wait(reader.value.read({ recallRef: b.intentRecallRef, actionRef: b.financialActionRef }, op.signal));
    if (!intent.ok || intent.value.recalled || intent.value.archivedAt !== null) throw new FinancialMessageProtocolRefusal("forbidden");
    const bookingGrant = this.#sourceQuery(b, b.observationRecallRef, b.observationActionRef); await this.#sourcePermit(bookingGrant, op);
    const booking = await op.wait(this.#records.readBookingObservation({ recallRef: b.observationRecallRef,
      actionRef: b.observationActionRef, intentRecallRef: b.intentRecallRef }, intent.value.intent, op.signal));
    await this.#sourcePermit(bookingGrant, op);
    if (!booking.ok || booking.value.recalled || booking.value.archivedAt !== null ||
        Date.parse(booking.value.observation.observedAt) > Date.parse(this.#now()) + 30_000) throw new FinancialMessageProtocolRefusal("mismatched");
    const creationGrant = this.#sourceQuery(b, b.checkoutAttemptRecallRef, b.checkoutAttemptActionRef); await this.#sourcePermit(creationGrant, op);
    const creation = await op.wait(this.#records.readCheckoutAttempt({ recallRef: b.checkoutAttemptRecallRef,
      actionRef: b.checkoutAttemptActionRef, intentRecallRef: b.intentRecallRef }, intent.value.intent, op.signal));
    await this.#sourcePermit(creationGrant, op);
    if (!creation.ok || creation.value.recalled || creation.value.archivedAt !== null ||
        creation.value.attempt.actionRef !== b.checkoutAttemptActionRef || creation.value.attempt.observationRecallRef !== b.observationRecallRef ||
        creation.value.attempt.observationActionRef !== b.observationActionRef || creation.value.attempt.targetRef !== booking.value.observation.targetRef) throw new FinancialMessageProtocolRefusal("mismatched");
    await this.#sourcePermit(query, op);
    return { intent: intent.value, booking: booking.value, creation: creation.value };
  }
  #now(): string {
    const now = this.#config.cliniko.clock?.() ?? new Date().toISOString();
    if (typeof now !== "string" || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new FinancialMessageProtocolRefusal("unavailable");
    return now;
  }
  async #query(b: FinancialMessageBinding, sources: FinancialMessageSources, purpose: FinancialMessagePurpose, op: FinancialMessageOperation): Promise<FinancialMessageQuery> {
    const i = sources.intent.intent, a = sources.creation.attempt;
    const correlated = await op.wait<Result<StripeCheckoutCorrelation | StripeCheckoutLinkContext, StripeReadFailure>>(
      purpose === "linkDelivery" ? this.#correlation.readLink(b.checkoutRef, op.signal) : this.#correlation.read(b.checkoutRef, op.signal));
    if (!correlated.ok) throw new FinancialMessageProtocolRefusal("unavailable");
    const c = correlated.value;
    if (c.financialActionRef !== i.actionRef || c.accountRef !== i.stripe.accountRef || c.livemode !== i.stripe.livemode ||
        c.effectRef !== i.effects.checkout || c.effectRef !== a.effectRef || c.intentDigest !== financialIntentDigest(i) || c.intentDigest !== a.intentDigest ||
        c.amount !== i.payment.amount || c.currency !== i.payment.currency || c.created < a.createdFrom || c.created > a.createdThrough) throw new FinancialMessageProtocolRefusal("mismatched");
    const evidence = await op.wait(this.#money.inspect({ checkoutRef: b.checkoutRef, actionRef: i.actionRef,
      amount: i.payment.amount, currency: i.payment.currency }, op.signal));
    if (!evidence.ok) throw new FinancialMessageProtocolRefusal("unavailable");
    let message: FinancialMail;
    if (purpose === "linkDelivery") {
      if (c.kind !== "linkContext" || evidence.value.kind !== "unpaid" || evidence.value.status !== "open" ||
          c.expiresAt !== i.payment.deadline || Date.parse(i.payment.deadline) <= Date.parse(this.#now())) throw new FinancialMessageProtocolRefusal("forbidden");
      message = { purpose, email: i.recipient.address, amount: i.payment.amount, currency: i.payment.currency, url: c.url, deadline: i.payment.deadline };
    } else {
      if (evidence.value.kind !== "received" || evidence.value.receiptUrl === null) throw new FinancialMessageProtocolRefusal("forbidden");
      message = { purpose, email: i.recipient.address, amount: i.payment.amount, currency: i.payment.currency, url: evidence.value.receiptUrl };
    }
    const payloadDigest = financialMessageDigest(this.#messageSelection, message); if (!payloadDigest) throw new FinancialMessageProtocolRefusal("mismatched");
    const base = frozen({ ...this.#selection, purpose: "financialMessageDelivery" as const, ownerBinding: this.#binding, binding: b,
      effectRef: i.effects[purpose], sources, correlation: c, money: evidence.value, selection: this.#messageSelection, message, payloadDigest });
    return frozen(await op.wait(this.#mode.query(base, op)));
  }
  async #permit(q: FinancialMessageQuery, op: FinancialMessageOperation): Promise<void> {
    for (const grant of [this.#authority.providerBindingAuthorized, this.#authority.messageAuthorized, this.#authority.producerAdmitted]) {
      if (await op.wait(Promise.resolve().then(() => grant(q, op.signal))) !== true) throw new FinancialMessageProtocolRefusal("forbidden"); op.current(q);
    }
    if (this.#mode.authorize) {
      if (await op.wait(this.#mode.authorize(q, op)) !== true) throw new FinancialMessageProtocolRefusal("forbidden"); op.current(q);
    }
  }
  async #history(b: FinancialMessageBinding, q: FinancialMessageQuery, op: FinancialMessageOperation): Promise<void> {
    const history = ClinikoFinancialWorkDiscovery.create(this.#config.cliniko, {
      allowsAccountRead: async account => {
        op.current(account); const allowed = await op.wait(this.#authority.attemptScanAuthorized(account, op.signal)); op.current(account); return allowed === true;
      },
      allowsRecordRead: record => this.#sourcePermit(this.#sourceQuery(b, record.recallRef, record.actionRef, true), op),
      current: record => { try { op.current("recallRef" in record ? this.#sourceQuery(b, record.recallRef, record.actionRef, true) : record); return true; } catch { return false; } },
    }, this.#native);
    if (!history.ok) throw new FinancialMessageProtocolRefusal("invalidConfig");
    const intent = q.sources.intent;
    const found = await op.wait(history.value.scanPatient({ patientId: intent.intent.patientId,
      createdFrom: new Date(Math.min(Date.parse(intent.intent.createdAt), Date.parse(intent.createdAt)) - 30_000).toISOString(),
      createdThrough: new Date(Date.parse(this.#now()) + 30_000).toISOString() }, op.signal));
    if (!found.ok) throw new FinancialMessageProtocolRefusal(found.error.kind === "forbidden" ? "forbidden" : "unavailable");
    if (this.#mode.hasPrior(found.value, q)) throw new FinancialMessageProtocolRefusal("alreadyClaimed");
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
    const op: FinancialMessageOperation = { signal, wait: async <T>(task: Promise<T>) => {
      const value = await awaitUntilAbort(task, signal); if (value === undefined || !active()) throw new FinancialMessageProtocolRefusal("unavailable"); return value;
    }, current: q => {
      if (!active() || this.#barrier.matches(this.#selection.scope, this.#binding) !== true ||
          !isDeepStrictEqual(this.#delivery.selection(), this.#messageSelection) || this.#authority.current(q, signal) !== true || !active()) throw new FinancialMessageProtocolRefusal("forbidden");
    } };
    let dispatched = false;
    try {
      const sources = await this.#sources(b, op), query = await this.#query(b, sources, purpose, op);
      await this.#permit(query, op); await this.#history(b, query, op); await this.#permit(query, op);
      if (this.#mode.beforeClaim && await op.wait(this.#mode.beforeClaim(query, op)) !== true) throw new FinancialMessageProtocolRefusal("unavailable");
      const plan = this.#mode.plan(query, this.#records, this.#now()); if (!plan) throw new FinancialMessageProtocolRefusal("invalidQuery");
      const effects = [...(this.#mode.extraClaims?.(query) ?? []), query.effectRef];
      if (!effects.every(validFinancialEffectRef) || new Set(effects).size !== effects.length) throw new FinancialMessageProtocolRefusal("invalidQuery");
      op.current(query);
      for (const effect of effects) {
        const claim = await op.wait(this.#barrier.claimOnce(effect));
        if (claim?.ok !== true || claim.value?.claimed !== true) throw new FinancialMessageProtocolRefusal(claim?.ok === true && claim.value?.claimed === false ? "alreadyClaimed" : "unavailable");
      }
      await this.#permit(query, op);
      const retained = await op.wait(plan.retain(signal));
      if (!retained.ok || retained.value.kind !== "accepted") throw new FinancialMessageProtocolRefusal("attemptUncertain");
      const freshSources = await this.#sources(b, op), fresh = await this.#query(b, freshSources, purpose, op);
      if (!isDeepStrictEqual(sourceData(freshSources), sourceData(sources)) || !isDeepStrictEqual(providerData(fresh), providerData(query))) throw new FinancialMessageProtocolRefusal("mismatched");
      if (!await op.wait(plan.matches(retained.value.recallRef, signal))) throw new FinancialMessageProtocolRefusal("mismatched");
      await this.#permit(fresh, op); op.current(fresh);
      dispatched = true;
      const sent = await awaitUntilAbort(Promise.resolve().then(() => this.#delivery.send(fresh.message, signal, fresh.effectRef)), signal);
      // An observed SMTP acceptance cannot be erased by a later observer/role
      // failure. Only this fixed outcome escapes; no private source/ref/URL does.
      if (sent?.kind === "accepted" && sent.messageRef === fresh.effectRef) return ok({ kind: "accepted" });
      return ok({ kind: sent?.kind === "definitiveUnsent" ? "definitiveUnsent" : "unknown" });
    } catch (error) {
      return dispatched ? ok({ kind: "unknown" }) : err({ kind: error instanceof FinancialMessageProtocolRefusal ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
