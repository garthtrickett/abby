import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import type { OwnedBodyStream } from "../shared/owned-body-bytes.ts";
import { StripeWebhookVerifier } from "../stripe/webhook.ts";
import type { StripeCheckoutNotification } from "../stripe/webhook.ts";
import { StripeCheckoutCorrelationReader } from "../stripe/checkout-correlation.ts";
import type { StripeCheckoutCorrelation } from "../stripe/checkout-correlation.ts";
import type { StripeReadConfig } from "../stripe/internal/api-read.ts";
import { ClinikoFinancialPendingDiscovery } from "../cliniko/financial-pending-discovery.ts";
import type { FinancialPendingAuthority, FinancialPendingResult } from "../cliniko/financial-pending-discovery.ts";
import type { FinancialDiscoveredWork, FinancialDiscoveredAttempt } from "../cliniko/financial-work-discovery.ts";
import { financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordRetentionConfig } from "../cliniko/financial-record-retention.ts";
import { financialSelection } from "../cliniko/internal/financial-record-context.ts";
import type { ClinikoFinancialReviewSelection } from "../cliniko/financial-review-read.ts";
import { financialIntentDigest } from "../cliniko/financial-booking-observation.ts";

type Pair = Extract<FinancialDiscoveredWork, { kind: "pairedContext" }>;
type Match = Readonly<{ pair: Pair; attempt: FinancialDiscoveredAttempt }>;
// Snapshot versions are selected independently at the Stripe event endpoint.
// Only verified references enter this handoff; REST financial reads stay Basil.
const supportedSnapshotVersions = ["2025-06-30.basil", "2026-09-30.endive"] as const;
export type FinancialWebhookReferenceQuery = ClinikoFinancialReviewSelection & Readonly<{
  purpose: "financialWebhookPendingHandoff"; ownerBinding: string; notification: StripeCheckoutNotification;
}>;
export type FinancialWebhookPendingQuery = FinancialWebhookReferenceQuery & Readonly<{
  correlation: StripeCheckoutCorrelation; pending: Match;
}>;
/** Explicit independently provisioned financial queue owner. Neither signature,
 * metadata nor a native read grant supplies permission to use pending work.
 * These checks must not enqueue, collect, deliver or expire work. No effect or
 * caller approval is inferred from this port. */
export type FinancialWebhookHandoffAuthority = Readonly<{
  allowsReferenceRead(query: FinancialWebhookReferenceQuery, signal: AbortSignal): Promise<boolean>;
  acceptsExistingPending(query: FinancialWebhookPendingQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialWebhookReferenceQuery | FinancialWebhookPendingQuery, signal: AbortSignal): boolean;
}>;
export type FinancialWebhookHandoffConfig = Readonly<{
  cliniko: FinancialRecordRetentionConfig; stripe: StripeReadConfig;
  webhook: ConstructorParameters<typeof StripeWebhookVerifier>[0]; deadlineMs?: number;
}>;
export type FinancialWebhookHandoffFailure = Readonly<{
  kind: "invalidConfig" | "invalidWebhook" | "foreignEndpoint" | "unsupportedVersion" | "forbidden" | "unavailable" | "notPending" | "mismatched";
}>;
type FailureKind = FinancialWebhookHandoffFailure["kind"];
class HandoffFailure extends Error { readonly kind: FailureKind; constructor(kind: FailureKind) { super("Financial handoff unavailable"); this.kind = kind; } }
function freeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function correlationData(c: StripeCheckoutCorrelation) { const { observedAt: _observedAt, ...data } = c; return data; }
function matchData(m: Match) {
  const { observedAt: _readAt, ...intent } = m.pair.intent;
  const { observedAt: _attemptReadAt, ...attemptIntent } = m.attempt.intent;
  return { pair: { ...m.pair, intent }, attempt: { ...m.attempt, intent: attemptIntent } };
}

/** Acknowledges only already durable, independently discoverable native work.
 * The intent/producer observation/attempt were retained before possible Stripe
 * creation. No local event queue, event-ref ledger, financial write or volatile
 * wake callback is used as durability. This is not money/lifecycle processing,
 * immutable provider history, queue completion or atomic cross-provider truth. */
export class ClinikoStripeWebhookHandoff {
  readonly #verifier: StripeWebhookVerifier;
  readonly #stripe: StripeCheckoutCorrelationReader;
  readonly #pending: ClinikoFinancialPendingDiscovery;
  readonly #query: Omit<FinancialWebhookReferenceQuery, "notification">;
  readonly #authority: FinancialWebhookHandoffAuthority;
  readonly #deadline: number;
  private constructor(config: FinancialWebhookHandoffConfig, authority: FinancialWebhookHandoffAuthority,
    pending: ClinikoFinancialPendingDiscovery, stripePort: typeof fetch, ownerBinding: string) {
    this.#verifier = new StripeWebhookVerifier(config.webhook); this.#stripe = new StripeCheckoutCorrelationReader(config.stripe, stripePort);
    this.#pending = pending; this.#deadline = config.deadlineMs ?? 10_000;
    this.#query = Object.freeze({ ...financialSelection(config.cliniko), purpose: "financialWebhookPendingHandoff", ownerBinding });
    this.#authority = Object.freeze({ allowsReferenceRead: authority.allowsReferenceRead.bind(authority),
      acceptsExistingPending: authority.acceptsExistingPending.bind(authority), current: authority.current.bind(authority) });
  }
  static create(config: FinancialWebhookHandoffConfig, authority: FinancialWebhookHandoffAuthority, pendingAuthority: FinancialPendingAuthority,
    nativePort: typeof fetch = fetch, stripePort: typeof fetch = fetch): Result<ClinikoStripeWebhookHandoff, FinancialWebhookHandoffFailure> {
    try {
      const owner = financialRecordOwnerBinding(config?.cliniko);
      if (!owner.ok || config.stripe.accountRef !== config.cliniko.stripe.accountRef || config.stripe.livemode !== config.cliniko.stripe.livemode ||
          config.stripe.apiVersion !== "2025-06-30.basil" || !supportedSnapshotVersions.some(version => version === config.webhook.apiVersion) ||
          config.webhook.livemode !== config.stripe.livemode || config.webhook.accountRef !== (config.stripe.connected ? config.stripe.accountRef : null) ||
          config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 10_000) ||
          typeof authority?.allowsReferenceRead !== "function" || typeof authority.acceptsExistingPending !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      const pending = ClinikoFinancialPendingDiscovery.create(config.cliniko, pendingAuthority, nativePort);
      if (!pending.ok) return err({ kind: "invalidConfig" });
      return ok(new ClinikoStripeWebhookHandoff(config, authority, pending.value, stripePort, owner.value));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #match(found: FinancialPendingResult, c: StripeCheckoutCorrelation): Match | undefined {
    const pairs = found.work.filter((p): p is Pair => p.kind === "pairedContext" && p.intent.intent.actionRef === c.financialActionRef);
    const attempts = found.attempts.filter(a => a.attempt.financialActionRef === c.financialActionRef);
    if (pairs.length !== 1 || attempts.length !== 1) return undefined;
    const pair = pairs[0]!, attempt = attempts[0]!, i = pair.intent.intent, a = attempt.attempt;
    if (pair.intent.recalled || pair.intent.archivedAt !== null || pair.recalled || pair.archivedAt !== null || attempt.recalled || attempt.archivedAt !== null ||
        attempt.intent.recalled || attempt.intent.archivedAt !== null || pair.intent.recallRef !== attempt.intent.recallRef ||
        a.intentRecallRef !== pair.intent.recallRef || a.observationRecallRef !== pair.observationRecallRef || a.observationActionRef !== pair.observation.actionRef ||
        a.targetRef !== pair.observation.targetRef || c.accountRef !== i.stripe.accountRef || c.livemode !== i.stripe.livemode ||
        c.amount !== i.payment.amount || c.currency !== i.payment.currency || c.effectRef !== i.effects.checkout || c.effectRef !== a.effectRef ||
        c.intentDigest !== financialIntentDigest(i) || c.intentDigest !== a.intentDigest || c.created < a.createdFrom || c.created > a.createdThrough) return undefined;
    return { pair, attempt };
  }
  async accept(body: OwnedBodyStream | null, signature: string | null, external: AbortSignal):
    Promise<Result<Readonly<{ kind: "acceptedExistingPending" | "ignored" }>, FinancialWebhookHandoffFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const began = performance.now(), deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#deadline), signal = AbortSignal.any([external, deadline.signal]);
    const expired = () => signal.aborted || performance.now() - began > this.#deadline;
    const wait = async <T>(task: Promise<T>): Promise<T> => { const result = await awaitUntilAbort(task, signal); if (result === undefined || expired()) throw new HandoffFailure("unavailable"); return result; };
    const current = (q: FinancialWebhookReferenceQuery | FinancialWebhookPendingQuery) => { if (expired() || this.#authority.current(q, signal) !== true) throw new HandoffFailure("forbidden"); };
    try {
      const verified = await wait(this.#verifier.verifyStream(body, signature, signal)); if (!verified.ok) return verified;
      if (verified.value === null) return ok({ kind: "ignored" });
      const reference = freeze({ ...this.#query, notification: verified.value });
      const permitReference = async () => { if (await wait(Promise.resolve().then(() => this.#authority.allowsReferenceRead(reference, signal))) !== true) throw new HandoffFailure("forbidden"); current(reference); };
      await permitReference();
      const correlation = await wait(this.#stripe.read(verified.value.checkoutRef, signal)); if (!correlation.ok) throw new HandoffFailure("unavailable");
      await permitReference();
      const first = await wait(this.#pending.scanPending(signal)); if (!first.ok) throw new HandoffFailure(first.error.kind === "forbidden" ? "forbidden" : "unavailable");
      const matched = this.#match(first.value, correlation.value); if (!matched) throw new HandoffFailure("notPending");
      const query = freeze({ ...reference, correlation: correlation.value, pending: matched });
      if (await wait(Promise.resolve().then(() => this.#authority.acceptsExistingPending(query, signal))) !== true) throw new HandoffFailure("forbidden"); current(query);
      const freshStripe = await wait(this.#stripe.read(verified.value.checkoutRef, signal));
      if (!freshStripe.ok || !isDeepStrictEqual(correlationData(freshStripe.value), correlationData(correlation.value))) throw new HandoffFailure("mismatched");
      const freshNative = await wait(this.#pending.scanPending(signal)); if (!freshNative.ok) throw new HandoffFailure("unavailable");
      const after = this.#match(freshNative.value, freshStripe.value);
      if (!after || !isDeepStrictEqual(matchData(after), matchData(matched))) throw new HandoffFailure("mismatched");
      current(reference); current(query);
      return ok({ kind: "acceptedExistingPending" });
    } catch (error) { return err({ kind: error instanceof HandoffFailure ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); deadline.abort(); }
  }
}
