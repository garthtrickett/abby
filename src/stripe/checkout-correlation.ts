import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { StripeApiRead, ReadError, record, ref, money } from "./internal/api-read.ts";
import type { StripeReadConfig, StripeReadFailure } from "./internal/api-read.ts";

export type StripeCheckoutCorrelation = Readonly<{
  kind: "correlation"; checkoutRef: string; accountRef: string; livemode: boolean; observedAt: string;
  financialActionRef: string; effectRef: string; intentDigest: string; amount: number; currency: string; created: number;
}>;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);

/** Exact account-scoped GET for a webhook/discovery reference. Returns only
 * current private correlation, never the event body, URL, recipient or payment
 * status. Metadata is mutable context, not an original-request receipt or grant.
 * Native intent/attempt/signature, independent current permission and producer/
 * restore admission must still be established before any financial effect. */
export class StripeCheckoutCorrelationReader {
  readonly #scope: Readonly<{ accountRef: string; livemode: boolean }>;
  readonly #api: StripeApiRead;
  constructor(config: StripeReadConfig, port: typeof fetch = fetch) {
    this.#api = new StripeApiRead(config, port);
    this.#scope = Object.freeze({ accountRef: config.accountRef, livemode: config.livemode });
  }
  async read(checkoutRef: string, signal: AbortSignal): Promise<Result<StripeCheckoutCorrelation, StripeReadFailure>> {
    const wanted = checkoutRef;
    if (!ref(wanted, "cs")) return err({ kind: "invalidBinding" });
    const result = await this.#api.run(signal, async get => {
      const session = await get("checkout/sessions/" + encodeURIComponent(wanted)), metadata = record(session.metadata);
      if (session.object !== "checkout.session" || session.id !== wanted || session.mode !== "payment" || session.livemode !== this.#scope.livemode ||
          !metadata || !uuid(session.client_reference_id) || metadata.abby_financial_action !== session.client_reference_id || !uuid(metadata.abby_effect) ||
          metadata.abby_effect === session.client_reference_id || typeof metadata.abby_intent_digest !== "string" || !/^[a-f0-9]{64}$/.test(metadata.abby_intent_digest) ||
          !money(session.amount_total) || session.amount_total < 1 || typeof session.currency !== "string" || !/^[a-z]{3}$/.test(session.currency) ||
          !Number.isSafeInteger(session.created) || Number(session.created) < 0 || Number(session.created) > 253_402_300_799) throw new ReadError("mismatched");
      return Object.freeze({ checkoutRef: wanted, accountRef: this.#scope.accountRef, livemode: this.#scope.livemode,
        financialActionRef: session.client_reference_id, effectRef: metadata.abby_effect, intentDigest: metadata.abby_intent_digest,
        amount: session.amount_total, currency: session.currency, created: Number(session.created) });
    });
    if (!result.ok) return result;
    if (result.value.data.created * 1_000 > Date.parse(result.value.observedAt) + 30_000) return err({ kind: "mismatched" });
    return ok(Object.freeze({ kind: "correlation", ...result.value.data, observedAt: result.value.observedAt }));
  }
}
