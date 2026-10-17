import assert from "node:assert/strict";
import test from "node:test";
import { StripeCheckoutCorrelationReader } from "../../src/stripe/checkout-correlation.ts";
import { checkoutFixture, value, now, stop } from "../support/financial-checkout-owner.ts";

const clock = 1_792_190_000_000;
const config = { apiKey: "sk_test_synthetic12345678", accountRef: "acct_synthetic", connected: true,
  livemode: false, apiVersion: "2025-06-30.basil", clock: () => clock };
const action = "12345678-abcd-4321-abcd-123456789abc", effect = "87654321-abcd-4321-abcd-123456789abc", digest = "b".repeat(64);
const session = () => ({ object: "checkout.session", id: "cs_test_exact", mode: "payment", livemode: false,
  client_reference_id: action, amount_total: 2500, currency: "nzd", created: clock / 1_000 - 10,
  metadata: { abby_financial_action: action, abby_effect: effect, abby_intent_digest: digest, patient: "private-patient-canary" },
  customer_email: "private-recipient@example.invalid", url: "https://checkout.stripe.com/c/pay/private-token", payment_status: "paid",
  payment_intent: { id: "pi_private", latest_charge: { receipt_url: "https://pay.stripe.com/receipts/private" } } });
function fixture(patch: Record<string, unknown> = {}, options: { account?: string; code?: number; port?: typeof fetch } = {}) {
  const calls: URL[] = [];
  const reader = new StripeCheckoutCorrelationReader(config, options.port ?? (async (input, init) => {
    const url = new URL(String(input)); calls.push(url); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    const headers = new Headers(init.headers); assert.equal(headers.get("Stripe-Account"), config.accountRef); assert.equal(headers.get("Stripe-Version"), config.apiVersion);
    return Response.json(url.pathname === "/v1/account" ? { object: "account", id: options.account ?? config.accountRef } : { ...session(), ...patch }, { status: options.code ?? 200 });
  }));
  return { reader, calls };
}

test("fresh Checkout correlation returns a private exact binding and no event, money state, recipient or delivery data", async () => {
  const f = fixture(), result = value(await f.reader.read("cs_test_exact", stop()));
  assert.deepEqual(result, { kind: "correlation", checkoutRef: "cs_test_exact", accountRef: config.accountRef, livemode: false,
    financialActionRef: action, effectRef: effect, intentDigest: digest, amount: 2500, currency: "nzd", created: clock / 1_000 - 10, observedAt: new Date(clock).toISOString() });
  assert.deepEqual(f.calls.map(url => url.pathname), ["/v1/account", "/v1/checkout/sessions/cs_test_exact"]);
  assert.ok(f.calls.every(url => url.search === "")); assert.ok(Object.isFrozen(result)); assert.equal(JSON.stringify(f.reader), "{}");
  assert.doesNotMatch(JSON.stringify(result), /private|recipient|payment_status|payment_intent|receipt|url/);
});

for (const [field, patch] of Object.entries({ foreignSession: { id: "cs_test_foreign" }, object: { object: "payment_intent" },
  subscription: { mode: "subscription" }, liveMode: { livemode: true }, missingAction: { client_reference_id: null },
  malformedAction: { client_reference_id: "other action" }, missingMetadata: { metadata: null },
  actionMismatch: { metadata: { ...session().metadata, abby_financial_action: effect } },
  reusedEffect: { metadata: { ...session().metadata, abby_effect: action } },
  unknownEffect: { metadata: { ...session().metadata, abby_effect: null } },
  malformedDigest: { metadata: { ...session().metadata, abby_intent_digest: "unknown" } },
  amount: { amount_total: 0 }, currency: { currency: "NZD" }, created: { created: 1.5 }, future: { created: clock / 1_000 + 31 } }))
test(`correlation refuses ${field} without releasing partial account/session context`, async () => {
  const f = fixture(patch); assert.deepEqual(await f.reader.read("cs_test_exact", stop()), { ok: false, error: { kind: "mismatched" } });
});

test("foreign account, invalid reference and an aborted caller never yield Checkout correlation", async () => {
  const f = fixture({}, { account: "acct_foreign" }); assert.equal((await f.reader.read("cs_test_exact", stop())).ok, false); assert.equal(f.calls.length, 1);
  const untouched = fixture(); const controller = new AbortController(); controller.abort();
  for (const id of ["", "cs_test_a/path", "cs_test_a?query=private", "https://foreign.invalid/private"]) assert.equal((await untouched.reader.read(id, stop())).ok, false);
  assert.equal((await untouched.reader.read("cs_test_exact", controller.signal)).ok, false); assert.equal(untouched.calls.length, 0);
});

test("correlation always rereads the provider and never promotes mutable metadata or a paid flag to authority", async () => {
  let current = session();
  const reader = new StripeCheckoutCorrelationReader(config, async input => Response.json(String(input).endsWith("/account") ? { object: "account", id: config.accountRef } : current));
  const first = value(await reader.read("cs_test_exact", stop()));
  current = { ...current, client_reference_id: effect, metadata: { ...current.metadata, abby_financial_action: effect, abby_effect: action } };
  const next = value(await reader.read("cs_test_exact", stop())); assert.equal(next.financialActionRef, effect); assert.equal(first.financialActionRef, action);
  assert.equal("payment_status" in next, false); assert.equal("kind" in next && next.kind === "correlation", true);
});

test("ignored provider cancellation, transport error and malformed JSON remain unavailable instead of partial context", async () => {
  for (const held of [false, true]) {
    const reader = new StripeCheckoutCorrelationReader({ ...config, deadlineMs: 20 }, async input => {
      if (String(input).endsWith("/account")) return Response.json({ object: "account", id: config.accountRef });
      return held ? new Promise<Response>(() => {}) : new Response("private provider failure", { status: 500 });
    });
    assert.deepEqual(await reader.read("cs_test_exact", stop()), { ok: false, error: { kind: "unavailable" } });
  }
  const broken = fixture({}, { port: async input => String(input).endsWith("/account") ? Response.json({ object: "account", id: config.accountRef }) : new Response("private invalid JSON") });
  assert.deepEqual(await broken.reader.read("cs_test_exact", stop()), { ok: false, error: { kind: "malformed" } });
});

test("a lost-ACK one-shot creation supplies fresh correlation while its native attempt still forbids replay", async () => {
  const f = await checkoutFixture({ stripe: (row, method) => { if (method === "POST") throw new Error("Synthetic lost ACK"); return Response.json(row); } });
  assert.equal(value(await f.owner.createOnce(f.binding, stop())).kind, "uncertain");
  const reader = new StripeCheckoutCorrelationReader({ ...f.config.stripe, clock: () => Date.parse(now) }, async (input, init) => {
    assert.equal(init?.method, "GET");
    return Response.json(String(input).endsWith("/account") ? { object: "account", id: f.config.stripe.accountRef } : f.sessions[0]);
  });
  const correlation = value(await reader.read("cs_test_owner", stop()));
  assert.equal(correlation.financialActionRef, f.intent.actionRef); assert.equal(correlation.effectRef, f.intent.effects.checkout);
  assert.equal((await value(f.make()).createOnce(f.binding, stop())).ok, false); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});
