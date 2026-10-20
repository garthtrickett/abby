import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { StripeApiRead, ReadError, record, ref, money } from "./internal/api-read.ts";
import type { StripeReadConfig, StripeReadFailure } from "./internal/api-read.ts";

export type StripeCheckoutReadFailure = StripeReadFailure;
export type StripeCheckoutBinding = Readonly<{ checkoutRef: string; actionRef: string; amount: number; currency: string }>;
type Common = StripeCheckoutBinding & Readonly<{ accountRef: string; livemode: boolean; observedAt: string; status: "open" | "complete" | "expired" }>;
type EvidenceState = (
  | Readonly<{ kind: "unpaid"; paymentClosed: boolean }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "received"; intentRef: string; chargeRef: string; receiptUrl: string | null }>
  | Readonly<{ kind: "adjusted"; intentRef: string; chargeRef: string; refundedAmount: number; disputed: boolean; receiptUrl: string | null }>
);
export type StripeCheckoutEvidence = Common & EvidenceState;
function receipt(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://pay.stripe.com" && !url.username && !url.password &&
      url.pathname.startsWith("/receipts/") && url.pathname.length > 10 ? url.toString() : null;
  } catch { return null; }
}

/** Read-only Stripe evidence for an independently owned financial intent.
 * The caller supplies its exact trusted binding and still needs current patient/
 * service permission. This neither receives a webhook body nor performs effects.
 * Received money is distinct from a receipt, a booking, settlement and coverage. */
export class StripeCheckoutReader {
  readonly #scope: Readonly<{ accountRef: string; livemode: boolean }>;
  readonly #api: StripeApiRead;
  constructor(config: StripeReadConfig, port: typeof fetch = fetch) {
    this.#api = new StripeApiRead(config, port);
    this.#scope = Object.freeze({ accountRef: config.accountRef, livemode: config.livemode });
  }

  async inspect(binding: StripeCheckoutBinding, external: AbortSignal): Promise<Result<StripeCheckoutEvidence, StripeCheckoutReadFailure>> {
    const wanted = Object.freeze({ checkoutRef: binding?.checkoutRef, actionRef: binding?.actionRef,
      amount: binding?.amount, currency: binding?.currency });
    if (!ref(wanted.checkoutRef, "cs") || typeof wanted.actionRef !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(wanted.actionRef) || !money(wanted.amount) || wanted.amount < 1 ||
        typeof wanted.currency !== "string" || !/^[a-z]{3}$/.test(wanted.currency)) return err({ kind: "invalidBinding" });
    const config = this.#scope;
    const result = await this.#api.run<Omit<Common, "observedAt"> & EvidenceState>(external, async get => {
      const session = await get("checkout/sessions/" + encodeURIComponent(wanted.checkoutRef) + "?expand%5B%5D=payment_intent.latest_charge");
      if (session.object !== "checkout.session" || session.id !== wanted.checkoutRef || session.mode !== "payment" ||
          session.livemode !== config.livemode || session.client_reference_id !== wanted.actionRef ||
          session.amount_total !== wanted.amount || session.currency !== wanted.currency) throw new ReadError("mismatched");
      if (session.status !== "open" && session.status !== "complete" && session.status !== "expired") throw new ReadError("malformed");
      const common: Omit<Common, "observedAt"> = { ...wanted, accountRef: config.accountRef, livemode: config.livemode, status: session.status };
      const intent = record(session.payment_intent);
      if (session.payment_intent !== null && (!intent || intent.object !== "payment_intent" || !ref(intent.id, "pi") ||
          intent.livemode !== config.livemode || intent.amount !== wanted.amount || intent.currency !== wanted.currency ||
          !money(intent.amount_received) || typeof intent.status !== "string" ||
          !["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"].includes(intent.status))) throw new ReadError("mismatched");
      if (session.payment_status === "unpaid") {
        if (intent && (intent.amount_received !== 0 || intent.status === "succeeded")) throw new ReadError("mismatched");
        if (intent && ["requires_action", "processing", "requires_capture"].some(status => status === intent.status)) return Object.freeze({ ...common, kind: "pending" });
        return Object.freeze({ ...common, kind: "unpaid", paymentClosed: session.status === "expired" && (!intent || intent.status === "canceled") });
      }
      if (session.payment_status !== "paid" || session.status === "open" || !intent || intent.status !== "succeeded" || intent.amount_received !== wanted.amount) throw new ReadError("mismatched");
      const charge = record(intent.latest_charge);
      if (!charge || charge.object !== "charge" || !ref(charge.id, "ch") || charge.payment_intent !== intent.id ||
          charge.livemode !== config.livemode || charge.amount !== wanted.amount || charge.amount_captured !== wanted.amount ||
          charge.currency !== wanted.currency || charge.status !== "succeeded" || charge.paid !== true || charge.captured !== true ||
          !money(charge.amount_refunded) || charge.amount_refunded > wanted.amount || typeof charge.disputed !== "boolean" ||
          charge.refunded !== (charge.amount_refunded === wanted.amount)) throw new ReadError("mismatched");
      const received = { ...common, intentRef: String(intent.id), chargeRef: String(charge.id), receiptUrl: receipt(charge.receipt_url) };
      if (charge.amount_refunded > 0 || charge.disputed) return Object.freeze({ ...received, kind: "adjusted", refundedAmount: charge.amount_refunded, disputed: charge.disputed });
      return Object.freeze({ ...received, kind: "received" });
    });
    return result.ok ? ok(Object.freeze({ ...result.value.data, observedAt: result.value.observedAt })) : result;
  }
}
