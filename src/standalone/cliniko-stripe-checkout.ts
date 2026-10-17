import { createHash, randomUUID } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import type { ClinikoFinancialReviewSelection, ClinikoFinancialReviewBinding } from "../cliniko/financial-review-read.ts";
import { ClinikoFinancialWorkDiscovery } from "../cliniko/financial-work-discovery.ts";
import type { FinancialDiscoveryAccountQuery } from "../cliniko/financial-work-discovery.ts";
import { ClinikoFinancialReviewReader } from "../cliniko/financial-review-read.ts";
import { ClinikoFinancialRecordRetainer, financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordRetentionConfig, FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import { financialIntentDigest } from "../cliniko/financial-booking-observation.ts";
import type { ClinikoFinancialIntent } from "../cliniko/financial-review-intent.ts";
import type { FinancialCheckoutAttempt } from "../cliniko/financial-checkout-attempt.ts";
import { validRecallDate, validRecallMarker } from "../cliniko/recall-note.ts";
import { StripeApiRead, ref, record } from "../stripe/internal/api-read.ts";
import type { StripeReadConfig } from "../stripe/internal/api-read.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";

export type CheckoutOwnerConfig = Readonly<{
  cliniko: FinancialRecordRetentionConfig; stripe: StripeReadConfig;
  /** Explicit clinic-approved public generic label and public return URLs. No
   * patient/appointment/correlation placeholders or query values are inserted. */
  productLabel: string; successUrl: string; cancelUrl: string;
  /** Initial adapter supports the explicitly approved card method only. */
  paymentMethod: "card";
}>;
export type CheckoutOwnerBinding = Readonly<{
  intentRecallRef: string; financialActionRef: string; observationRecallRef: string; observationActionRef: string;
  /** Explicit approved clinic review date; not derived from a UTC deadline. */
  reviewDate: string;
}>;
export type CheckoutOwnerQuery = CheckoutOwnerBinding & Readonly<{
  ownerBinding: string; intent: ClinikoFinancialIntent; targetRef: string;
  productLabel: string; successUrl: string; cancelUrl: string; paymentMethod: "card";
}>;
/** Independent current financial owner, exact fee/recipient/contact-purpose and
 * separately played collection consent. Clinical yes, termsVersion, caller OTP,
 * signed booking observation or a restored claim do not supply either grant. */
export type CheckoutOwnerAuthority = Readonly<{
  attemptScanAuthorized(query: FinancialDiscoveryAccountQuery, signal: AbortSignal): Promise<boolean>;
  sourceAuthorized(query: ClinikoFinancialReviewSelection & ClinikoFinancialReviewBinding, signal: AbortSignal): Promise<boolean>;
  collectionAuthorized(query: CheckoutOwnerQuery, signal: AbortSignal): Promise<boolean>;
  producerAdmitted(query: CheckoutOwnerQuery, signal: AbortSignal): Promise<boolean>;
  current(query: CheckoutOwnerQuery, signal: AbortSignal): boolean;
}>;
export type CheckoutOwnerFailure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "unavailable" | "alreadyClaimed" | "mismatched" | "attemptUncertain" }>;
/** Private outcome only. Created is not received money or delivered email.
 * Neither uncertain nor any refusal grants permission to submit again. */
export type CheckoutOwnerResult = Readonly<{ attemptRecallRef: string }> & (
  Readonly<{ kind: "created"; checkoutRef: string; url: string; expiresAt: string }> | Readonly<{ kind: "createdWithheld" }> | Readonly<{ kind: "uncertain" }>
);
class CheckoutFailure extends Error {
  readonly kind: CheckoutOwnerFailure["kind"];
  constructor(kind: CheckoutOwnerFailure["kind"]) { super("Checkout unavailable"); this.kind = kind; }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function publicUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 1_024 || /[{}\s]/.test(value)) return false;
  try { const u = new URL(value); return u.protocol === "https:" && !!u.hostname && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
function discard(r: Response | undefined): void { try { void r?.body?.cancel().catch(() => {}); } catch { /* No upstream private data. */ } }

/** One owner command joins fresh native context, independent authorization,
 * opaque durable exclusion, durable provider attempt evidence and ONE Stripe
 * POST. It has no local pending payload, implicit role, replay or caller route. */
export class ClinikoStripeCheckoutOwner {
  readonly #config: CheckoutOwnerConfig;
  readonly #reader: ClinikoFinancialReviewReader;
  readonly #records: ClinikoFinancialRecordRetainer;
  readonly #stripe: StripeApiRead;
  readonly #port: typeof fetch;
  readonly #clinikoPort: typeof fetch;
  readonly #authority: CheckoutOwnerAuthority;
  readonly #claim: FinancialEffectBarrier["claimOnce"];
  readonly #binding: string;
  private constructor(config: CheckoutOwnerConfig, authority: CheckoutOwnerAuthority, barrier: FinancialEffectBarrier,
                      reader: ClinikoFinancialReviewReader, records: ClinikoFinancialRecordRetainer, stripe: StripeApiRead, port: typeof fetch, binding: string, clinikoPort: typeof fetch) {
    this.#config = Object.freeze({ ...config, stripe: Object.freeze({ ...config.stripe }) });
    this.#clinikoPort = clinikoPort; this.#reader = reader; this.#records = records; this.#stripe = stripe; this.#port = port; this.#claim = barrier.claimOnce.bind(barrier); this.#binding = binding;
    this.#authority = Object.freeze({ attemptScanAuthorized: authority.attemptScanAuthorized.bind(authority), sourceAuthorized: authority.sourceAuthorized.bind(authority), collectionAuthorized: authority.collectionAuthorized.bind(authority),
      producerAdmitted: authority.producerAdmitted.bind(authority), current: authority.current.bind(authority) });
  }
  static create(config: CheckoutOwnerConfig, authority: CheckoutOwnerAuthority, recordAuthority: FinancialRecordAuthority,
                barrier: FinancialEffectBarrier, clinikoPort: typeof fetch = fetch, stripePort: typeof fetch = fetch): Result<ClinikoStripeCheckoutOwner, CheckoutOwnerFailure> {
    try {
      const binding = financialRecordOwnerBinding(config?.cliniko);
      if (!binding.ok || typeof authority?.attemptScanAuthorized !== "function" || typeof authority.sourceAuthorized !== "function" || typeof authority.collectionAuthorized !== "function" || typeof authority.producerAdmitted !== "function" || typeof authority.current !== "function" ||
          config.stripe.accountRef !== config.cliniko.stripe.accountRef || config.stripe.livemode !== config.cliniko.stripe.livemode ||
          config.stripe.apiVersion !== "2025-06-30.basil" || !config.stripe.apiKey.startsWith(config.stripe.livemode ? "sk_live_" : "sk_test_") &&
          !config.stripe.apiKey.startsWith(config.stripe.livemode ? "rk_live_" : "rk_test_") ||
          config.paymentMethod !== "card" || typeof config.productLabel !== "string" || !/^[\x20-\x7e]{1,120}$/.test(config.productLabel) || !config.productLabel.trim() ||
          !publicUrl(config.successUrl) || !publicUrl(config.cancelUrl)) return err({ kind: "invalidConfig" });
      const sourceAuthorized = authority.sourceAuthorized.bind(authority);
      const reader = ClinikoFinancialReviewReader.create(config.cliniko, { allows: sourceAuthorized }, clinikoPort);
      const records = ClinikoFinancialRecordRetainer.create(config.cliniko, recordAuthority, barrier, clinikoPort);
      if (!reader.ok || !records.ok) return err({ kind: "invalidConfig" });
      return ok(new ClinikoStripeCheckoutOwner(config, authority, barrier, reader.value, records.value,
        new StripeApiRead(config.stripe, stripePort), stripePort, binding.value, clinikoPort));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async createOnce(input: CheckoutOwnerBinding, external: AbortSignal): Promise<Result<CheckoutOwnerResult, CheckoutOwnerFailure>> {
    const wanted = Object.freeze({ intentRecallRef: input?.intentRecallRef, financialActionRef: input?.financialActionRef,
      observationRecallRef: input?.observationRecallRef, observationActionRef: input?.observationActionRef, reviewDate: input?.reviewDate });
    if (![wanted.intentRecallRef, wanted.observationRecallRef].every(v => typeof v === "string" && /^cliniko:recall:[1-9][0-9]{0,18}$/.test(v)) ||
        wanted.intentRecallRef === wanted.observationRecallRef || ![wanted.financialActionRef, wanted.observationActionRef].every(validRecallMarker) ||
        !validRecallDate(wanted.reviewDate)) return err({ kind: "invalidQuery" });
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 60_000), signal = AbortSignal.any([external, deadline.signal]);
    const began = performance.now(); let dispatched = false, accepted = false, attemptRecallRef: string | undefined;
    let response: Response | undefined, bodyOwned = false;
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const result = await awaitUntilAbort(task, signal);
      if (result === undefined || signal.aborted || performance.now() - began > 60_000) throw new CheckoutFailure("unavailable");
      return result;
    };
    const now = () => {
      const n = this.#config.stripe.clock?.() ?? Date.now();
      if (!Number.isSafeInteger(n) || n < 0) throw new CheckoutFailure("unavailable"); return n;
    };
    try {
      const context = await wait(this.#reader.read({ recallRef: wanted.intentRecallRef, actionRef: wanted.financialActionRef }, signal));
      if (!context.ok || context.value.recalled || context.value.archivedAt !== null) throw new CheckoutFailure(context.ok ? "forbidden" : context.error.kind === "forbidden" ? "forbidden" : "unavailable");
      const intent = freeze(structuredClone(context.value.intent));
      const observed = await wait(this.#records.readBookingObservation({ recallRef: wanted.observationRecallRef, actionRef: wanted.observationActionRef,
        intentRecallRef: wanted.intentRecallRef }, intent, signal));
      if (!observed.ok || observed.value.recalled || observed.value.archivedAt !== null) throw new CheckoutFailure(observed.ok ? "forbidden" : observed.error.kind === "forbidden" ? "forbidden" : "unavailable");
      const query = freeze({ ...wanted, ownerBinding: this.#binding, intent, targetRef: observed.value.observation.targetRef,
        productLabel: this.#config.productLabel, successUrl: this.#config.successUrl, cancelUrl: this.#config.cancelUrl, paymentMethod: this.#config.paymentMethod });
      const expiresAt = Date.parse(intent.payment.deadline) / 1_000;
      const checkCurrent = () => {
        const t = now() / 1_000;
        if (signal.aborted || !Number.isSafeInteger(expiresAt) || expiresAt - t < 1_800 || expiresAt - t > 86_400 ||
            Date.parse(intent.createdAt) > now() || this.#authority.current(query, signal) !== true) throw new CheckoutFailure("forbidden");
      };
      const permit = async () => {
        if (await wait(Promise.resolve().then(() => this.#authority.collectionAuthorized(query, signal))) !== true ||
            await wait(Promise.resolve().then(() => this.#authority.producerAdmitted(query, signal))) !== true) throw new CheckoutFailure("forbidden");
        checkCurrent();
      };
      await permit();
      // Stripe account introspection precedes the irreversible local exclusion.
      const account = await wait(this.#stripe.run(signal, async () => true));
      if (!account.ok) throw new CheckoutFailure(account.error.kind === "mismatched" ? "mismatched" : "unavailable");
      await permit();
      const discovery = ClinikoFinancialWorkDiscovery.create(this.#config.cliniko, {
        allowsAccountRead: this.#authority.attemptScanAuthorized,
        allowsRecordRead: this.#authority.sourceAuthorized,
        current: (_q, stop) => !stop.aborted && this.#authority.current(query, signal) === true,
      }, this.#clinikoPort);
      if (!discovery.ok) throw new CheckoutFailure("unavailable");
      const history = await wait(discovery.value.scanPatient({ patientId: intent.patientId, createdFrom: intent.createdAt,
        createdThrough: new Date(now()).toISOString() }, signal));
      if (!history.ok) throw new CheckoutFailure(history.error.kind === "forbidden" ? "forbidden" : "unavailable");
      if (history.value.attempts.some(a => a.attempt.effectRef === intent.effects.checkout || a.attempt.financialActionRef === intent.actionRef)) throw new CheckoutFailure("alreadyClaimed");
      await permit();
      const body = new URLSearchParams({ mode: "payment", ui_mode: "hosted", client_reference_id: intent.actionRef,
        success_url: query.successUrl, cancel_url: query.cancelUrl, expires_at: String(expiresAt),
        "payment_method_types[0]": "card", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": intent.payment.currency,
        "line_items[0][price_data][unit_amount]": String(intent.payment.amount), "line_items[0][price_data][product_data][name]": query.productLabel,
        "automatic_tax[enabled]": "false", "adaptive_pricing[enabled]": "false", allow_promotion_codes: "false",
        "metadata[abby_financial_action]": intent.actionRef, "metadata[abby_effect]": intent.effects.checkout,
        "metadata[abby_intent_digest]": financialIntentDigest(intent)! });
      const start = Math.floor(now() / 1_000), attempt: FinancialCheckoutAttempt = Object.freeze({ actionRef: randomUUID(),
        financialActionRef: intent.actionRef, effectRef: intent.effects.checkout, intentRecallRef: wanted.intentRecallRef, intentDigest: financialIntentDigest(intent)!,
        observationRecallRef: wanted.observationRecallRef, observationActionRef: wanted.observationActionRef, targetRef: query.targetRef,
        requestDigest: createHash("sha256").update(body.toString()).digest("hex"), createdFrom: start - 30, createdThrough: start + 60 });
      checkCurrent();
      const claimed = await wait(this.#claim(intent.effects.checkout));
      if (claimed?.ok !== true || claimed.value?.claimed !== true) throw new CheckoutFailure(claimed?.ok === true && claimed.value?.claimed === false ? "alreadyClaimed" : "unavailable");
      await permit();
      const retained = await wait(this.#records.retainCheckoutAttemptOnce(attempt, { intent, intentRecallRef: wanted.intentRecallRef,
        observationRecallRef: wanted.observationRecallRef, observation: observed.value.observation }, wanted.reviewDate, signal));
      if (!retained.ok || retained.value.kind !== "accepted") throw new CheckoutFailure("attemptUncertain");
      attemptRecallRef = retained.value.recallRef;
      // Provider records are editable. Do not use a pre-retention snapshot after
      // that asynchronous handoff if either exact source was changed/closed.
      const freshIntent = await wait(this.#reader.read({ recallRef: wanted.intentRecallRef, actionRef: wanted.financialActionRef }, signal));
      const freshObservation = await wait(this.#records.readBookingObservation({ recallRef: wanted.observationRecallRef,
        actionRef: wanted.observationActionRef, intentRecallRef: wanted.intentRecallRef }, intent, signal));
      if (!freshIntent.ok || freshIntent.value.recalled || freshIntent.value.archivedAt !== null ||
          financialIntentDigest(freshIntent.value.intent) !== attempt.intentDigest || !freshObservation.ok ||
          freshObservation.value.recalled || freshObservation.value.archivedAt !== null ||
          JSON.stringify(freshObservation.value.observation) !== JSON.stringify(observed.value.observation)) throw new CheckoutFailure("mismatched");
      await permit();
      if (now() / 1_000 >= attempt.createdThrough) throw new CheckoutFailure("forbidden");
      const postDeadline = new AbortController(), postTimer = setTimeout(() => postDeadline.abort(), this.#config.stripe.deadlineMs ?? 10_000);
      const postSignal = AbortSignal.any([signal, postDeadline.signal]);
      try {
        checkCurrent(); dispatched = true;
        const incoming = this.#port("https://api.stripe.com/v1/checkout/sessions", { method: "POST", redirect: "error", signal: postSignal,
          headers: { Authorization: `Bearer ${this.#config.stripe.apiKey}`, "Stripe-Version": this.#config.stripe.apiVersion,
            "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `abby-checkout-${intent.effects.checkout}`,
            ...(this.#config.stripe.connected ? { "Stripe-Account": this.#config.stripe.accountRef } : {}) }, body: body.toString() })
          .then(r => { response = r; if (postSignal.aborted) discard(r); return r; });
        const received = await awaitUntilAbort(incoming, postSignal);
        if (!received || postSignal.aborted || received.status !== 200) throw new CheckoutFailure("unavailable");
        bodyOwned = true;
        const bytes = await ownedBodyBytes(received.body, 1_000_000, postSignal);
        const session = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        const metadata = record(session?.metadata), details = record(session?.total_details);
        const url = typeof session?.url === "string" && session.url.length <= 4_096 ? new URL(session.url) : undefined;
        if (!session || session.object !== "checkout.session" || !ref(session.id, "cs") || session.mode !== "payment" ||
            session.livemode !== intent.stripe.livemode || session.client_reference_id !== intent.actionRef ||
            session.amount_total !== intent.payment.amount || session.amount_subtotal !== intent.payment.amount || session.currency !== intent.payment.currency ||
            session.status !== "open" || session.payment_status !== "unpaid" || session.payment_intent !== null || session.expires_at !== expiresAt ||
            !Number.isSafeInteger(session.created) || Number(session.created) < attempt.createdFrom || Number(session.created) > attempt.createdThrough ||
            metadata?.abby_financial_action !== intent.actionRef || metadata.abby_effect !== intent.effects.checkout || metadata.abby_intent_digest !== attempt.intentDigest ||
            details?.amount_discount !== 0 || details.amount_shipping !== 0 || details.amount_tax !== 0 ||
            record(session.automatic_tax)?.enabled !== false || record(session.adaptive_pricing)?.enabled === true ||
            !url || url.origin !== "https://checkout.stripe.com" || url.username || url.password || url.search || !url.pathname.startsWith(`/c/pay/${session.id}`) ||
            url.pathname !== `/c/pay/${session.id}`) throw new CheckoutFailure("mismatched");
        // Creation truth survives later permission loss, just like a booking
        // receipt. Current read permission still gates disclosure of its URL.
        accepted = true;
        await permit();
        return ok({ kind: "created", attemptRecallRef, checkoutRef: String(session.id), url: url.toString(), expiresAt: intent.payment.deadline });
      } finally { clearTimeout(postTimer); postDeadline.abort(); }
    } catch (error) {
      return accepted && attemptRecallRef ? ok({ kind: "createdWithheld", attemptRecallRef }) : dispatched && attemptRecallRef ? ok({ kind: "uncertain", attemptRecallRef }) : err({ kind: error instanceof CheckoutFailure ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); deadline.abort(); if (!bodyOwned) discard(response); }
  }
}
