import assert from "node:assert/strict";
import { ClinikoStripeCheckoutOwner } from "../../src/standalone/cliniko-stripe-checkout.ts";
import type { CheckoutOwnerAuthority, CheckoutOwnerConfig, CheckoutOwnerBinding } from "../../src/standalone/cliniko-stripe-checkout.ts";
import { fixture, observation, value, now, reviewDate, stop, base, uuid } from "./financial-retention.ts";
import { decodeClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import { verifyFinancialBookingObservation } from "../../src/cliniko/financial-booking-observation.ts";

type Row = Record<string, unknown>;
/** Adopt already-retained native bytes. This path never seeds or re-signs a booking. */
export type RetainedFinancialBooking = Readonly<{
  native: ReturnType<typeof fixture>; intent: ReturnType<typeof fixture>["intent"]; binding: CheckoutOwnerBinding;
  otherReviews?: () => readonly Row[];
}>;
export async function checkoutFixture(options: {
  retained?: RetainedFinancialBooking; native?: Parameters<typeof fixture>[0]; authority?: Partial<CheckoutOwnerAuthority>; config?: Partial<CheckoutOwnerConfig>;
  bookingObservation?: (intent: ReturnType<typeof fixture>["intent"]) => string;
  stripe?: (row: Row, method: string) => Response | Promise<Response>;
} = {}) {
  const retained = options.retained;
  if (retained) {
    assert.equal(options.native, undefined, "retained context cannot select a replacement native fixture");
    assert.equal(options.bookingObservation, undefined, "retained observation cannot be manufactured");
    const intentId = /^cliniko:recall:([1-9][0-9]*)$/.exec(retained.binding.intentRecallRef)?.[1];
    const observationId = /^cliniko:recall:([1-9][0-9]*)$/.exec(retained.binding.observationRecallRef)?.[1];
    assert.ok(intentId && observationId && intentId !== observationId);
    assert.deepEqual(value(decodeClinikoFinancialIntent(retained.native.rows.get(intentId)?.notes)), retained.intent);
    const source = value(verifyFinancialBookingObservation(retained.native.rows.get(observationId)?.notes, {
      intent: retained.intent, intentRecallRef: retained.binding.intentRecallRef,
      producerKeyRef: retained.native.config.producer.keyRef, publicKey: retained.native.config.producer.publicKey }));
    assert.equal(source.actionRef, retained.binding.observationActionRef);
    assert.equal(retained.intent.actionRef, retained.binding.financialActionRef);
  }
  const f = retained ? { ...retained.native, intent: retained.intent } : fixture(options.native);
  if (!retained) {
    f.seedIntent();
    const captured = value(await f.retainer.retainBookingObservationOnce(options.bookingObservation?.(f.intent) ?? observation(f.intent),
      { intent: f.intent, intentRecallRef: "cliniko:recall:30" }, reviewDate, stop()));
    assert.equal(captured.kind, "accepted");
  }
  let allowed = true, admitted = true, current = true;
  const requests: { url: string; method: string; body: string; headers: Headers }[] = [], queries: unknown[] = [], sessions: Row[] = [];
  const config: CheckoutOwnerConfig = { cliniko: f.config, stripe: { apiKey: "sk_test_synthetic12345678", accountRef: f.intent.stripe.accountRef,
    livemode: f.intent.stripe.livemode, connected: true, apiVersion: "2025-06-30.basil", clock: () => Date.parse(f.config.clock?.() ?? now) },
    paymentMethod: "card", productLabel: "Clinic deposit", successUrl: "https://clinic.example.invalid/payment-complete", cancelUrl: "https://clinic.example.invalid/payment-return", ...options.config };
  const authority: CheckoutOwnerAuthority = { attemptScanAuthorized: async () => allowed, sourceAuthorized: async () => allowed,
    collectionAuthorized: async q => { queries.push(q); return allowed; }, producerAdmitted: async () => admitted, current: () => current, ...options.authority };
  const stripePort: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? "GET", headers = new Headers(init?.headers), body = String(init?.body ?? "");
    requests.push({ url, method, body, headers }); assert.equal(init?.redirect, "error");
    assert.equal(headers.get("Authorization"), `Bearer ${config.stripe.apiKey}`); assert.equal(headers.get("Stripe-Account"), config.stripe.accountRef);
    assert.equal(headers.get("Stripe-Version"), "2025-06-30.basil");
    if (url.endsWith("/account")) return options.stripe ? options.stripe({ object: "account", id: config.stripe.accountRef }, method) : Response.json({ object: "account", id: config.stripe.accountRef });
    assert.equal(method, "POST"); assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
    const params = new URLSearchParams(body);
    const row = { object: "checkout.session", id: "cs_test_owner", mode: "payment", livemode: config.stripe.livemode,
      client_reference_id: params.get("client_reference_id"), amount_total: f.intent.payment.amount, amount_subtotal: f.intent.payment.amount,
      currency: f.intent.payment.currency, status: "open", payment_status: "unpaid", payment_intent: null,
      expires_at: Number(params.get("expires_at")), created: Math.floor((config.stripe.clock?.() ?? Date.parse(now)) / 1_000),
      metadata: { abby_financial_action: params.get("metadata[abby_financial_action]"), abby_effect: params.get("metadata[abby_effect]"), abby_intent_digest: params.get("metadata[abby_intent_digest]") },
      total_details: { amount_tax: 0, amount_shipping: 0, amount_discount: 0 }, automatic_tax: { enabled: false }, adaptive_pricing: { enabled: false },
      url: "https://checkout.stripe.com/c/pay/cs_test_owner#private-checkout-token", private_unknown: "private-stripe-response-canary" };
    sessions.push(row); return options.stripe ? options.stripe(row, method) : Response.json(row);
  };
  const nativePort: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/recalls" && init?.method === "GET") {
      const from = url.searchParams.getAll("q[]").find(q => q.startsWith("created_at:>="))?.slice(13);
      const through = url.searchParams.getAll("q[]").find(q => q.startsWith("created_at:<="))?.slice(13);
      const rows = [...f.rows.values(), ...(retained?.otherReviews?.() ?? [])].filter(row => (!from || String(row.created_at) >= from) && (!through || String(row.created_at) <= through))
        .sort((a, b) => Number(a.id) - Number(b.id));
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({ total_entries: rows.length, recalls: rows.slice((page - 1) * 100, page * 100) });
    }
    return f.port(input, init);
  };
  const make = () => ClinikoStripeCheckoutOwner.create(config, authority, f.authority, f.barrier, nativePort, stripePort);
  const binding = retained?.binding ?? { intentRecallRef: "cliniko:recall:30", financialActionRef: f.intent.actionRef, observationRecallRef: "cliniko:recall:31", observationActionRef: uuid(8), reviewDate };
  return { ...f, config, checkoutAuthority: authority, owner: value(make()), make, binding, requests, queries, sessions, nativePort, stripePort,
    forbid: () => { allowed = false; }, unadmitCheckout: () => { admitted = false; }, expireCheckout: () => { current = false; } };
}
export { value, now, reviewDate, stop, base, uuid };
