import assert from "node:assert/strict";
import { financialMessageFixture, value, now, stop } from "./financial-message-owner.ts";
import { ClinikoCheckoutExpiryOwner } from "../../src/standalone/cliniko-checkout-expiry-owner.ts";
import type { CheckoutExpiryAuthority, CheckoutExpiryQuery } from "../../src/standalone/cliniko-checkout-expiry-owner.ts";

export async function expiryFixture(options: {
  authority?: Partial<CheckoutExpiryAuthority>; deadlineMs?: number;
  retained?(row: Record<string, unknown>): void | Promise<void>;
  post?(row: Record<string, unknown>): Response | Promise<Response>;
} = {}) {
  let clock = Date.parse(now);
  const f = await financialMessageFixture({ checkout: { native: { response: async (row, method) => {
    if (method === "POST" && String(row.notes).includes("financial expiry attempt")) {
      row.created_at = new Date(clock).toISOString(); row.updated_at = row.created_at; await options.retained?.(row);
    }
    return Response.json(row, { status: method === "POST" ? 201 : 200 });
  } } } });
  clock = Date.parse(f.intent.payment.deadline) + 1_000;
  let source = true, history = true, reference = true, provider = true, allowed = true, admitted = true, live = true;
  const posts: { url: string; headers: Headers }[] = [], queries: CheckoutExpiryQuery[] = [];
  const authority: CheckoutExpiryAuthority = { sources: { allows: async () => source, allowsHistory: async () => history, current: () => live },
    referenceAuthorized: async () => reference, providerBindingAuthorized: async () => provider,
    expiryAuthorized: async q => { queries.push(q); return allowed; }, producerAdmitted: async () => admitted, current: () => live, ...options.authority };
  const config = { cliniko: { ...f.config.cliniko, clock: () => new Date(clock).toISOString() }, stripe: { ...f.config.stripe, clock: () => clock },
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }) };
  const stripePort: typeof fetch = async (input, init) => {
    if (init?.method !== "POST") return f.stripePort(input, init);
    assert.equal(String(input), "https://api.stripe.com/v1/checkout/sessions/cs_test_owner/expire");
    assert.equal(init.redirect, "error"); assert.equal(init.body, "");
    const headers = new Headers(init.headers); assert.equal(headers.get("Stripe-Account"), f.intent.stripe.accountRef);
    assert.equal(headers.get("Stripe-Version"), "2025-06-30.basil"); assert.equal(headers.get("Idempotency-Key"), `abby-checkout-expiry-${f.intent.effects.checkoutExpiry}`);
    posts.push({ url: String(input), headers });
    if (options.post) return options.post(f.sessions[0]!);
    f.sessions[0]!.status = "expired"; f.sessions[0]!.url = null; return Response.json(f.sessions[0]);
  };
  const make = () => ClinikoCheckoutExpiryOwner.create(config, authority, f.recordsAuthority, f.barrier, f.nativePort, stripePort);
  const expiry = value(make());
  return { ...f, config, expiryAuthority: authority, expiry, makeExpiry: make, posts, expiryQueries: queries, expiryStripePort: stripePort,
    expireOnce: (signal = stop()) => expiry.expireOnce(f.binding, signal), beforeDeadline: () => { clock = Date.parse(f.intent.payment.deadline) - 1; },
    denySource: () => { source = false; }, denyHistory: () => { history = false; }, denyReference: () => { reference = false; },
    denyProvider: () => { provider = false; }, denyExpiry: () => { allowed = false; }, denyProducer: () => { admitted = false; }, retire: () => { live = false; },
    naturallyExpired: () => { f.sessions[0]!.status = "expired"; f.sessions[0]!.url = null; } };
}
export { value, now, stop };
