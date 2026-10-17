import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ClinikoFinancialPendingDiscovery } from "../cliniko/financial-pending-discovery.ts";
import type { FinancialPendingAuthority } from "../cliniko/financial-pending-discovery.ts";
import { financialRecordOwnerBinding } from "../cliniko/financial-record-retention.ts";
import type { FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import { StripeCheckoutDiscovery } from "../stripe/checkout-discovery.ts";
import { StripeCheckoutReader } from "../stripe/checkout-read.ts";
import { ClinikoStripeCheckoutOwner } from "./cliniko-stripe-checkout.ts";
import type { CheckoutOwnerConfig, CheckoutOwnerAuthority } from "./cliniko-stripe-checkout.ts";
import { ClinikoFinancialMessageOwner } from "./cliniko-financial-message-owner.ts";
import type { FinancialMessageAuthority } from "./cliniko-financial-message-owner.ts";
import type { FinancialMessageDelivery } from "./smtp-financial-message-delivery.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import { ClinikoStripeWebhookHandoff } from "./cliniko-stripe-webhook-handoff.ts";
import type { FinancialWebhookHandoffConfig, FinancialWebhookHandoffAuthority } from "./cliniko-stripe-webhook-handoff.ts";
import { stripeFinancialWebhookHandler } from "./stripe-financial-webhook-handler.ts";
import { ClinikoFinancialClinicalExpiryOwner } from "./cliniko-financial-clinical-expiry.ts";
import type { FinancialClinicalExpiryAuthority } from "./cliniko-financial-clinical-expiry.ts";
import { ClinikoCheckoutExpiryOwner } from "./cliniko-checkout-expiry-owner.ts";
import type { CheckoutExpiryAuthority } from "./cliniko-checkout-expiry-owner.ts";
import { consumeFinancialPair } from "./financial-consumer-turn.ts";
import type { FinancialConsumerAuthority } from "./financial-consumer-turn.ts";

export type FinancialConsumerConfig = Readonly<{
  checkout: CheckoutOwnerConfig; webhook: FinancialWebhookHandoffConfig["webhook"];
  pollEveryMs: number; cycleDeadlineMs: number;
}>;
export type FinancialConsumerRunQuery = Readonly<{ purpose: "runFinancialConsumer"; ownerBinding: string }>;
export type FinancialConsumerCycle = Readonly<{
  kind: "observed" | "unavailable"; paired: number; creationAcknowledged: number;
  messageAccepted: number; clinicalExpiryCancelled: number; checkoutExpiryAcknowledged: number; checkoutClosedUnpaid: number; alreadyAttempted: number; reviewRequired: number;
}>;
export type FinancialConsumerAuthorities = Readonly<{
  run: Readonly<{ allows(query: FinancialConsumerRunQuery, signal: AbortSignal): Promise<boolean>;
    current(query: FinancialConsumerRunQuery, signal: AbortSignal): boolean }>;
  pending: FinancialPendingAuthority; checkout: CheckoutOwnerAuthority; message: FinancialMessageAuthority;
  /** Absent means this host is not provisioned to expire Checkout Sessions. */
  checkoutExpiry?: CheckoutExpiryAuthority;
  /** Independent native/manual financial and captured clinical consent authority. */
  clinicalExpiry?: FinancialClinicalExpiryAuthority;
  records: FinancialRecordAuthority; work: FinancialConsumerAuthority; webhook: FinancialWebhookHandoffAuthority;
}>;
type Failure = Readonly<{ kind: "invalidConfig" | "unavailable" | "alreadyStarted" }>;
type Dependencies = Readonly<{
  barrier: FinancialEffectBarrier; delivery: FinancialMessageDelivery;
  native?: typeof fetch; stripe?: typeof fetch;
  /** Counts only. No error strings, references, recipient or provider context. */
  onCycle?(cycle: FinancialConsumerCycle): void;
}>;
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
  });
}

/** Explicitly provisioned periodic owner and raw webhook route. Construction
 * starts nothing. Native pending reviews, not local payload/event queues or
 * volatile callbacks, survive this service. Each cycle is sequential/bounded;
 * webhook acceptance requires this consumer's current running lifecycle and
 * the separate handoff grant. This is not a claim of complete clinic approval. */
export class ClinikoFinancialConsumer {
  readonly #config: FinancialConsumerConfig;
  readonly #authority: FinancialConsumerAuthorities;
  readonly #query: FinancialConsumerRunQuery;
  readonly #pending: ClinikoFinancialPendingDiscovery;
  readonly #checkout: ClinikoStripeCheckoutOwner;
  readonly #messages: ClinikoFinancialMessageOwner;
  readonly #expiry: ClinikoCheckoutExpiryOwner | undefined;
  readonly #clinicalExpiry: ClinikoFinancialClinicalExpiryOwner | undefined;
  readonly #discovery: StripeCheckoutDiscovery;
  readonly #money: StripeCheckoutReader;
  readonly #onCycle: Dependencies["onCycle"];
  readonly #stop = new AbortController();
  #done: Promise<void> | undefined;
  #lifetime: AbortSignal | undefined;
  #running = false;
  #route: ReturnType<typeof stripeFinancialWebhookHandler> | undefined;
  private constructor(config: FinancialConsumerConfig, authority: FinancialConsumerAuthorities, dependencies: Dependencies,
    ownerBinding: string, pending: ClinikoFinancialPendingDiscovery, checkout: ClinikoStripeCheckoutOwner, messages: ClinikoFinancialMessageOwner, expiry: ClinikoCheckoutExpiryOwner | undefined, clinicalExpiry: ClinikoFinancialClinicalExpiryOwner | undefined) {
    this.#config = Object.freeze({ ...config });
    this.#authority = Object.freeze({ ...authority,
      run: Object.freeze({ allows: authority.run.allows.bind(authority.run), current: authority.run.current.bind(authority.run) }),
      work: Object.freeze({ authorizeWork: authority.work.authorizeWork.bind(authority.work),
        providerBindingAuthorized: authority.work.providerBindingAuthorized.bind(authority.work),
        onCheckoutAcknowledged: authority.work.onCheckoutAcknowledged.bind(authority.work), current: authority.work.current.bind(authority.work) }) });
    this.#query = Object.freeze({ purpose: "runFinancialConsumer", ownerBinding });
    this.#clinicalExpiry = clinicalExpiry; this.#expiry = expiry; this.#pending = pending; this.#checkout = checkout; this.#messages = messages; this.#onCycle = dependencies.onCycle;
    this.#discovery = new StripeCheckoutDiscovery(config.checkout.stripe, dependencies.stripe);
    this.#money = new StripeCheckoutReader(config.checkout.stripe, dependencies.stripe);
  }
  static create(config: FinancialConsumerConfig, authority: FinancialConsumerAuthorities, dependencies: Dependencies): Result<ClinikoFinancialConsumer, Failure> {
    try {
      const binding = financialRecordOwnerBinding(config?.checkout?.cliniko);
      if (!binding.ok || !Number.isSafeInteger(config.pollEveryMs) || config.pollEveryMs < 1_000 || config.pollEveryMs > 3_600_000 ||
          !Number.isSafeInteger(config.cycleDeadlineMs) || config.cycleDeadlineMs < 1_000 || config.cycleDeadlineMs > 120_000 ||
          [authority?.run?.allows, authority?.run?.current, authority?.work?.authorizeWork, authority?.work?.providerBindingAuthorized,
            authority?.work?.onCheckoutAcknowledged, authority?.work?.current, authority?.webhook?.allowsReferenceRead,
            authority?.webhook?.acceptsExistingPending, authority?.webhook?.current].some(v => typeof v !== "function") ||
          dependencies.onCycle !== undefined && typeof dependencies.onCycle !== "function") return err({ kind: "invalidConfig" });
      const pending = ClinikoFinancialPendingDiscovery.create(config.checkout.cliniko, authority.pending, dependencies.native);
      const checkout = ClinikoStripeCheckoutOwner.create(config.checkout, authority.checkout, authority.records, dependencies.barrier, dependencies.native, dependencies.stripe);
      const messages = ClinikoFinancialMessageOwner.create({ cliniko: config.checkout.cliniko, stripe: config.checkout.stripe }, authority.message,
        authority.records, dependencies.barrier, dependencies.delivery, dependencies.native, dependencies.stripe);
      if (!pending.ok || !checkout.ok || !messages.ok) return err({ kind: "invalidConfig" });
      const expiry = authority.checkoutExpiry === undefined ? undefined : ClinikoCheckoutExpiryOwner.create({ cliniko: config.checkout.cliniko, stripe: config.checkout.stripe },
        authority.checkoutExpiry, authority.records, dependencies.barrier, dependencies.native, dependencies.stripe);
      if (expiry && !expiry.ok) return err({ kind: "invalidConfig" });
      const clinicalExpiry = authority.clinicalExpiry === undefined ? undefined : ClinikoFinancialClinicalExpiryOwner.create({ cliniko: config.checkout.cliniko, stripe: config.checkout.stripe },
        authority.clinicalExpiry, authority.records, dependencies.barrier, dependencies.native, dependencies.stripe);
      if (clinicalExpiry && !clinicalExpiry.ok) return err({ kind: "invalidConfig" });
      const consumer = new ClinikoFinancialConsumer(config, authority, dependencies, binding.value, pending.value, checkout.value, messages.value, expiry?.ok ? expiry.value : undefined, clinicalExpiry?.ok ? clinicalExpiry.value : undefined);
      const webhook = Object.freeze({ allowsReferenceRead: authority.webhook.allowsReferenceRead.bind(authority.webhook),
        acceptsExistingPending: authority.webhook.acceptsExistingPending.bind(authority.webhook), current: authority.webhook.current.bind(authority.webhook) });
      const handoff = ClinikoStripeWebhookHandoff.create({ cliniko: config.checkout.cliniko, stripe: config.checkout.stripe, webhook: config.webhook }, {
        allowsReferenceRead: async (q, signal) => await consumer.#admitted(signal) && await webhook.allowsReferenceRead(q, signal) === true,
        acceptsExistingPending: async (q, signal) => await consumer.#admitted(signal) && await webhook.acceptsExistingPending(q, signal) === true,
        current: (q, signal) => consumer.#current(signal) && webhook.current(q, signal) === true,
      }, authority.pending, dependencies.native, dependencies.stripe);
      if (!handoff.ok) return err({ kind: "invalidConfig" });
      consumer.#route = stripeFinancialWebhookHandler(handoff.value);
      return ok(consumer);
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #current(signal: AbortSignal): boolean {
    return this.#running && this.#lifetime?.aborted === false && !this.#stop.signal.aborted && !signal.aborted && this.#authority.run.current(this.#query, signal) === true;
  }
  async #admitted(signal: AbortSignal): Promise<boolean> {
    if (!this.#current(signal)) return false;
    return await awaitUntilAbort(Promise.resolve().then(() => this.#authority.run.allows(this.#query, signal)), signal) === true && this.#current(signal);
  }
  /** Host wires this exact raw route; no public listener is opened here. */
  get handle(): ReturnType<typeof stripeFinancialWebhookHandler>["handle"] { return this.#route!.handle; }
  start(external: AbortSignal): Result<Readonly<{ done: Promise<void> }>, Failure> {
    if (this.#done) return err({ kind: "alreadyStarted" });
    if (!(external instanceof AbortSignal) || external.aborted || this.#stop.signal.aborted) return err({ kind: "unavailable" });
    this.#running = true;
    const signal = AbortSignal.any([external, this.#stop.signal]);
    this.#lifetime = signal;
    this.#done = this.#loop(signal).finally(() => { this.#running = false; });
    return ok(Object.freeze({ done: this.#done }));
  }
  async close(): Promise<void> {
    this.#running = false; this.#stop.abort(); await this.#route?.close(); await this.#done;
  }
  async #cycle(parent: AbortSignal): Promise<FinancialConsumerCycle> {
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#config.cycleDeadlineMs);
    const signal = AbortSignal.any([parent, deadline.signal]);
    const counts = { clinicalExpiryCancelled: 0, paired: 0, creationAcknowledged: 0, messageAccepted: 0, checkoutExpiryAcknowledged: 0, checkoutClosedUnpaid: 0, alreadyAttempted: 0, reviewRequired: 0 };
    try {
      if (!await this.#admitted(signal)) return Object.freeze({ kind: "unavailable", ...counts });
      const pending = await this.#pending.scanPending(signal);
      if (!pending.ok || !await this.#admitted(signal)) return Object.freeze({ kind: "unavailable", ...counts });
      for (const work of pending.value.work) {
        if (work.kind !== "pairedContext") { counts.reviewRequired++; continue; }
        counts.paired++;
        if (!await this.#admitted(signal)) return Object.freeze({ kind: "unavailable", ...counts });
        const authority = this.#authority.work;
        const result = await consumeFinancialPair(work, pending.value.attempts, {
          ...(this.#clinicalExpiry ? { clinicalExpiry: this.#clinicalExpiry } : {}), ...(this.#expiry ? { expiry: this.#expiry } : {}), ownerBinding: this.#query.ownerBinding, checkout: this.#checkout, messages: this.#messages, discovery: this.#discovery, money: this.#money,
          authority: { ...authority, authorizeWork: (q, stop) => authority.authorizeWork(q, stop),
            providerBindingAuthorized: (q, stop) => authority.providerBindingAuthorized(q, stop),
            onCheckoutAcknowledged: (receipt, stop) => authority.onCheckoutAcknowledged(receipt, stop),
            current: (q, stop) => this.#current(stop) && authority.current(q, stop) === true },
        }, signal);
        counts[result]++;
      }
      return Object.freeze({ kind: "observed", ...counts });
    } catch { return Object.freeze({ kind: "unavailable", ...counts }); }
    finally { clearTimeout(timer); deadline.abort(); }
  }
  async #loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const cycle = await this.#cycle(signal);
      try { this.#onCycle?.(cycle); } catch { /* Counts observer cannot replay effects or disclose failure payloads. */ }
      await delay(this.#config.pollEveryMs, signal);
    }
  }
}
