import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";

type FailureKind = "invalidBinding" | "unavailable" | "forbidden" | "malformed" | "mismatched";
export type StripeCheckoutReadFailure = Readonly<{ kind: FailureKind }>;
export type StripeCheckoutBinding = Readonly<{ checkoutRef: string; actionRef: string; amount: number; currency: string }>;
type Common = StripeCheckoutBinding & Readonly<{ accountRef: string; livemode: boolean; observedAt: string; status: "open" | "complete" | "expired" }>;
export type StripeCheckoutEvidence = Common & (
  | Readonly<{ kind: "unpaid"; paymentClosed: boolean }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "received"; intentRef: string; chargeRef: string; receiptUrl: string | null }>
  | Readonly<{ kind: "adjusted"; intentRef: string; chargeRef: string; refundedAmount: number; disputed: boolean; receiptUrl: string | null }>
);
type Config = Readonly<{ apiKey: string; accountRef: string; connected: boolean; livemode: boolean; apiVersion: string;
  clock?: () => number; deadlineMs?: number }>;
class ReadError extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind) { super("Stripe read failed"); this.kind = kind; }
}
const record = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const ref = (v: unknown, prefix: string) => typeof v === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,200}$`).test(v);
const money = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 99_999_999;
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
  readonly #config: Config;
  readonly #fetch: typeof fetch;
  constructor(config: Config, port: typeof fetch = fetch) {
    if (!config || typeof config.apiKey !== "string" || !/^(?:sk|rk)_(?:test|live)_[\x21-\x7e]{8,500}$/.test(config.apiKey) ||
        !ref(config.accountRef, "acct") || typeof config.connected !== "boolean" || typeof config.livemode !== "boolean" ||
        typeof config.apiVersion !== "string" || !/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/.test(config.apiVersion) ||
        config.clock !== undefined && typeof config.clock !== "function" || typeof port !== "function" ||
        config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 10_000)) {
      throw new TypeError("invalid Stripe reader configuration");
    }
    this.#config = Object.freeze({ ...config }); this.#fetch = port;
  }

  async inspect(binding: StripeCheckoutBinding, external: AbortSignal): Promise<Result<StripeCheckoutEvidence, StripeCheckoutReadFailure>> {
    const wanted = Object.freeze({ checkoutRef: binding?.checkoutRef, actionRef: binding?.actionRef,
      amount: binding?.amount, currency: binding?.currency });
    if (!ref(wanted.checkoutRef, "cs") || typeof wanted.actionRef !== "string" ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(wanted.actionRef) || !money(wanted.amount) || wanted.amount < 1 ||
        typeof wanted.currency !== "string" || !/^[a-z]{3}$/.test(wanted.currency)) return err({ kind: "invalidBinding" });
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const config = this.#config, deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), config.deadlineMs ?? 10_000);
    const signal = AbortSignal.any([external, deadline.signal]);
    let onAbort = () => {};
    const aborted = new Promise<undefined>(resolve => { onAbort = () => resolve(undefined); signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort(); });
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const value = await Promise.race([task, aborted]);
      if (value === undefined || signal.aborted) throw new ReadError("unavailable"); return value;
    };
    const get = async (path: string) => {
      const response = await wait(this.#fetch("https://api.stripe.com/v1/" + path, { method: "GET", redirect: "error", signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, "Stripe-Version": config.apiVersion,
          ...(config.connected ? { "Stripe-Account": config.accountRef } : {}) } }));
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new ReadError(response.status === 401 || response.status === 403 ? "forbidden" : "unavailable");
      }
      if (!response.body) throw new ReadError("malformed");
      const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
      try {
        while (true) {
          const next = await wait(reader.read()); if (next.done) break;
          size += next.value.byteLength; if (size > 1_000_000) throw new ReadError("malformed");
          chunks.push(Buffer.from(next.value));
        }
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new ReadError("malformed"); }
        const object = record(value); if (!object) throw new ReadError("malformed"); return object;
      } finally {
        void reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch { /* Cancellation retires a held read. */ }
      }
    };
    try {
      const started = (config.clock ?? Date.now)();
      if (!Number.isSafeInteger(started) || started < 0) throw new ReadError("unavailable");
      const account = await get("account");
      if (account.object !== "account" || account.id !== config.accountRef) throw new ReadError("mismatched");
      const session = await get("checkout/sessions/" + encodeURIComponent(wanted.checkoutRef) + "?expand%5B%5D=payment_intent.latest_charge");
      const ended = (config.clock ?? Date.now)();
      if (!Number.isSafeInteger(ended) || ended < started || ended - started > (config.deadlineMs ?? 10_000) || signal.aborted) throw new ReadError("unavailable");
      if (session.object !== "checkout.session" || session.id !== wanted.checkoutRef || session.mode !== "payment" ||
          session.livemode !== config.livemode || session.client_reference_id !== wanted.actionRef ||
          session.amount_total !== wanted.amount || session.currency !== wanted.currency) throw new ReadError("mismatched");
      if (session.status !== "open" && session.status !== "complete" && session.status !== "expired") throw new ReadError("malformed");
      const common: Common = { ...wanted, accountRef: config.accountRef, livemode: config.livemode, observedAt: new Date(ended).toISOString(), status: session.status };
      const intent = record(session.payment_intent);
      if (session.payment_intent !== null && (!intent || intent.object !== "payment_intent" || !ref(intent.id, "pi") ||
          intent.livemode !== config.livemode || intent.amount !== wanted.amount || intent.currency !== wanted.currency ||
          !money(intent.amount_received) || typeof intent.status !== "string" ||
          !["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"].includes(intent.status))) throw new ReadError("mismatched");
      if (session.payment_status === "unpaid") {
        if (intent && (intent.amount_received !== 0 || intent.status === "succeeded")) throw new ReadError("mismatched");
        if (intent && ["requires_action", "processing", "requires_capture"].some(status => status === intent.status)) return ok(Object.freeze({ ...common, kind: "pending" }));
        return ok(Object.freeze({ ...common, kind: "unpaid", paymentClosed: session.status === "expired" && (!intent || intent.status === "canceled") }));
      }
      if (session.payment_status !== "paid" || session.status === "open" || !intent || intent.status !== "succeeded" || intent.amount_received !== wanted.amount) throw new ReadError("mismatched");
      const charge = record(intent.latest_charge);
      if (!charge || charge.object !== "charge" || !ref(charge.id, "ch") || charge.payment_intent !== intent.id ||
          charge.livemode !== config.livemode || charge.amount !== wanted.amount || charge.amount_captured !== wanted.amount ||
          charge.currency !== wanted.currency || charge.status !== "succeeded" || charge.paid !== true || charge.captured !== true ||
          !money(charge.amount_refunded) || charge.amount_refunded > wanted.amount || typeof charge.disputed !== "boolean" ||
          charge.refunded !== (charge.amount_refunded === wanted.amount)) throw new ReadError("mismatched");
      const received = { ...common, intentRef: String(intent.id), chargeRef: String(charge.id), receiptUrl: receipt(charge.receipt_url) };
      if (charge.amount_refunded > 0 || charge.disputed) return ok(Object.freeze({ ...received, kind: "adjusted", refundedAmount: charge.amount_refunded, disputed: charge.disputed }));
      return ok(Object.freeze({ ...received, kind: "received" }));
    } catch (error) { return err({ kind: error instanceof ReadError ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
  }
}
