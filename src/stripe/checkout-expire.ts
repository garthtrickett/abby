import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { StripeApiRead, record, ref } from "./internal/api-read.ts";
import type { StripeReadConfig } from "./internal/api-read.ts";
import type { StripeCheckoutExpiryContext } from "./checkout-correlation.ts";
import { validFinancialEffectRef } from "../standalone/financial-effect-barrier.ts";

/** Private transport outcome only. An expiry ACK is not closed-unpaid evidence,
 * an appointment cancellation or permission to replay after uncertainty. */
export type StripeExpirySubmission = Readonly<{ kind: "acknowledged" | "unknown" }>;
export class StripeCheckoutExpirer {
  readonly #config: StripeReadConfig;
  readonly #port: typeof fetch;
  constructor(config: StripeReadConfig, port: typeof fetch = fetch) {
    new StripeApiRead(config, port); // Same pinned config/credential validation.
    this.#config = Object.freeze({ ...config }); this.#port = port;
  }
  /** ONE exact POST; the independent owner must retain native possible-dispatch
   * evidence and consume its durable one-use exclusion before invoking this. */
  async expire(wanted: StripeCheckoutExpiryContext, effectRef: string, external: AbortSignal, beforePost: () => void): Promise<StripeExpirySubmission> {
    if (!wanted || !ref(wanted.checkoutRef, "cs") || !validFinancialEffectRef(effectRef) ||
        wanted.accountRef !== this.#config.accountRef || wanted.livemode !== this.#config.livemode ||
        !(external instanceof AbortSignal) || external.aborted) return { kind: "unknown" };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#config.deadlineMs ?? 10_000);
    const signal = AbortSignal.any([external, controller.signal]); let response: Response | undefined, owned = false;
    try {
      beforePost(); if (signal.aborted) return { kind: "unknown" };
      const incoming = this.#port(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(wanted.checkoutRef)}/expire`, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${this.#config.apiKey}`, "Stripe-Version": this.#config.apiVersion,
          "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `abby-checkout-expiry-${effectRef}`,
          ...(this.#config.connected ? { "Stripe-Account": this.#config.accountRef } : {}) }, body: "",
      }).then(r => { response = r; if (signal.aborted) void r.body?.cancel().catch(() => {}); return r; });
      const received = await awaitUntilAbort(incoming, signal);
      if (!received || signal.aborted || received.status !== 200) return { kind: "unknown" };
      owned = true;
      const bytes = await ownedBodyBytes(received.body, 1_000_000, signal);
      const session = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), metadata = record(session?.metadata);
      if (signal.aborted || !session || session.object !== "checkout.session" || session.id !== wanted.checkoutRef ||
          session.status !== "expired" || session.mode !== "payment" || session.livemode !== wanted.livemode ||
          session.client_reference_id !== wanted.financialActionRef || session.amount_total !== wanted.amount || session.currency !== wanted.currency ||
          session.created !== wanted.created || session.expires_at !== Date.parse(wanted.expiresAt) / 1000 ||
          metadata?.abby_financial_action !== wanted.financialActionRef || metadata.abby_effect !== wanted.effectRef || metadata.abby_intent_digest !== wanted.intentDigest)
        return { kind: "unknown" };
      return { kind: "acknowledged" };
    } catch { return { kind: "unknown" }; }
    finally { clearTimeout(timer); controller.abort(); if (!owned) try { void response?.body?.cancel().catch(() => {}); } catch { /* Owned cleanup. */ } }
  }
}
