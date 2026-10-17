import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { StripeApiRead, ReadError, record, ref, money } from "./internal/api-read.ts";
import type { StripeReadConfig, StripeReadFailure } from "./internal/api-read.ts";

export type StripeCheckoutCorrelation = Readonly<{
  kind: "correlation"; checkoutRef: string; accountRef: string; livemode: boolean; observedAt: string;
  financialActionRef: string; effectRef: string; intentDigest: string; amount: number; currency: string; created: number;
}>;
export type StripeCheckoutLinkContext = Omit<StripeCheckoutCorrelation, "kind"> & Readonly<{
  kind: "linkContext"; url: string; expiresAt: string;
}>;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
type Scope = Readonly<{ accountRef: string; livemode: boolean }>;
function data(session: Record<string, unknown>, wanted: string, scope: Scope): Omit<StripeCheckoutCorrelation, "kind" | "observedAt"> {
  const metadata = record(session.metadata);
  if (session.object !== "checkout.session" || session.id !== wanted || session.mode !== "payment" || session.livemode !== scope.livemode ||
      !metadata || !uuid(session.client_reference_id) || metadata.abby_financial_action !== session.client_reference_id || !uuid(metadata.abby_effect) ||
      metadata.abby_effect === session.client_reference_id || typeof metadata.abby_intent_digest !== "string" || !/^[a-f0-9]{64}$/.test(metadata.abby_intent_digest) ||
      !money(session.amount_total) || session.amount_total < 1 || typeof session.currency !== "string" || !/^[a-z]{3}$/.test(session.currency) ||
      !Number.isSafeInteger(session.created) || Number(session.created) < 0 || Number(session.created) > 253_402_300_799) throw new ReadError("mismatched");
  return Object.freeze({ checkoutRef: wanted, accountRef: scope.accountRef, livemode: scope.livemode,
    financialActionRef: session.client_reference_id, effectRef: metadata.abby_effect, intentDigest: metadata.abby_intent_digest,
    amount: session.amount_total, currency: session.currency, created: Number(session.created) });
}

/** Exact account-scoped GET for a webhook/discovery reference. Returns only
 * current private correlation, never the event body, URL, recipient or payment
 * status. Metadata is mutable context, not an original-request receipt or grant.
 * Native intent/attempt/signature, independent current permission and producer/
 * restore admission must still be established before any financial effect. */
export class StripeCheckoutCorrelationReader {
  readonly #scope: Scope;
  readonly #api: StripeApiRead;
  constructor(config: StripeReadConfig, port: typeof fetch = fetch) {
    this.#api = new StripeApiRead(config, port);
    this.#scope = Object.freeze({ accountRef: config.accountRef, livemode: config.livemode });
  }
  async read(checkoutRef: string, signal: AbortSignal): Promise<Result<StripeCheckoutCorrelation, StripeReadFailure>> {
    const wanted = checkoutRef;
    if (!ref(wanted, "cs")) return err({ kind: "invalidBinding" });
    const result = await this.#api.run(signal, async get => {
      return data(await get("checkout/sessions/" + encodeURIComponent(wanted)), wanted, this.#scope);
    });
    if (!result.ok) return result;
    if (result.value.data.created * 1_000 > Date.parse(result.value.observedAt) + 30_000) return err({ kind: "mismatched" });
    return ok(Object.freeze({ kind: "correlation", ...result.value.data, observedAt: result.value.observedAt }));
  }
  /** Private capability read for an independently authorized delivery owner.
   * This does not prove money, creation history, recipient or send permission.
   * The reference-only read above continues to omit every URL/status field. */
  async readLink(checkoutRef: string, signal: AbortSignal): Promise<Result<StripeCheckoutLinkContext, StripeReadFailure>> {
    if (!ref(checkoutRef, "cs")) return err({ kind: "invalidBinding" });
    const result = await this.#api.run(signal, async get => {
      const session = await get("checkout/sessions/" + encodeURIComponent(checkoutRef)), correlation = data(session, checkoutRef, this.#scope);
      if (session.status !== "open" || session.payment_status !== "unpaid" || typeof session.url !== "string" || session.url.length > 4096 ||
          /[\p{Cc}\p{Cf}\s]/u.test(session.url) || !Number.isSafeInteger(session.expires_at) ||
          Number(session.expires_at) <= correlation.created || Number(session.expires_at) > 253_402_300_799) throw new ReadError("mismatched");
      let url: URL; try { url = new URL(session.url); } catch { throw new ReadError("mismatched"); }
      if (url.origin !== "https://checkout.stripe.com" || url.username || url.password || url.search || url.pathname !== `/c/pay/${checkoutRef}`) throw new ReadError("mismatched");
      return { ...correlation, url: url.toString(), expiresAt: new Date(Number(session.expires_at) * 1000).toISOString() };
    });
    if (!result.ok) return result;
    if (result.value.data.created * 1000 > Date.parse(result.value.observedAt) + 30_000 ||
        Date.parse(result.value.data.expiresAt) <= Date.parse(result.value.observedAt)) return err({ kind: "mismatched" });
    return ok(Object.freeze({ kind: "linkContext", ...result.value.data, observedAt: result.value.observedAt }));
  }
}
