import assert from "node:assert/strict";
import test from "node:test";
import { StripeCheckoutReader } from "../../src/stripe/checkout-read.ts";

const now = 1_792_190_000_000;
const config = { apiKey: "sk_test_synthetic12345678", accountRef: "acct_synthetic", connected: true,
  livemode: false, apiVersion: "2025-06-30.basil", clock: () => now };
const binding = { checkoutRef: "cs_test_synthetic", actionRef: "12345678-abcd-4321-abcd-123456789abc", amount: 2500, currency: "nzd" };
const charge = () => ({ object: "charge", id: "ch_synthetic", payment_intent: "pi_synthetic", livemode: false,
  amount: 2500, amount_captured: 2500, currency: "nzd", status: "succeeded", paid: true, captured: true,
  refunded: false, amount_refunded: 0, disputed: false, receipt_url: "https://pay.stripe.com/receipts/payment/synthetic",
  receipt_email: "private-patient@example.test", payment_method_details: { card: { last4: "1234" } } });
const intent = () => ({ object: "payment_intent", id: "pi_synthetic", livemode: false, amount: 2500, currency: "nzd",
  amount_received: 2500, status: "succeeded", latest_charge: charge(), client_secret: "private-client-secret" });
const session = () => ({ object: "checkout.session", id: binding.checkoutRef, mode: "payment", livemode: false,
  client_reference_id: binding.actionRef, amount_total: 2500, currency: "nzd", status: "complete", payment_status: "paid",
  payment_intent: intent(), customer_email: "private-patient@example.test", metadata: { patient: "private-patient-id" } });
function fixture(value: unknown = session(), account: unknown = { object: "account", id: config.accountRef }) {
  const calls: { url: string; method: string; headers: Headers }[] = [];
  const port: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init!.method!, headers: new Headers(init!.headers) });
    return Response.json(String(url).endsWith("/account") ? account : value);
  };
  return { reader: new StripeCheckoutReader(config, port), calls };
}
const signal = () => new AbortController().signal;

test("Stripe fresh exact account/action/amount/currency reads establish captured money independently of receipt availability", async () => {
  const f = fixture(), result = await f.reader.inspect(binding, signal()); assert.ok(result.ok);
  assert.equal(result.value.kind, "received"); assert.equal(result.value.amount, 2500);
  assert.equal(result.value.observedAt, new Date(now).toISOString()); assert.ok(Object.isFrozen(result.value));
  assert.doesNotMatch(JSON.stringify(result), /private-|last4|card|sk_test/);
  assert.equal(JSON.stringify(f.reader), "{}");
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(c => c.method === "GET"));
  assert.deepEqual(f.calls.map(c => c.url), ["https://api.stripe.com/v1/account",
    "https://api.stripe.com/v1/checkout/sessions/cs_test_synthetic?expand%5B%5D=payment_intent.latest_charge"]);
  for (const c of f.calls) {
    assert.equal(c.headers.get("Authorization"), `Bearer ${config.apiKey}`);
    assert.equal(c.headers.get("Stripe-Account"), config.accountRef);
    assert.equal(c.headers.get("Stripe-Version"), config.apiVersion);
  }
  for (const receipt_url of [null, "https://foreign.test/receipt", "https://pay.stripe.com.evil.test/receipts/x", "https://user:pass@pay.stripe.com/receipts/x", "bad"]) {
    const s = session(); Object.assign(s.payment_intent.latest_charge, { receipt_url });
    const r = await fixture(s).reader.inspect(binding, signal()); assert.ok(r.ok && r.value.kind === "received");
    assert.equal(r.value.receiptUrl, null, "receipt failure does not erase received money");
  }
});

test("Stripe wrong owning account stops before Checkout; direct-account requests omit Connect scope headers", async () => {
  const f = fixture(session(), { object: "account", id: "acct_foreign" });
  assert.deepEqual(await f.reader.inspect(binding, signal()), { ok: false, error: { kind: "mismatched" } });
  assert.equal(f.calls.length, 1);
  const headers: Headers[] = [];
  const reader = new StripeCheckoutReader({ ...config, connected: false }, async (url, init) => {
    headers.push(new Headers(init!.headers)); return Response.json(String(url).endsWith("/account") ? { object: "account", id: config.accountRef } : session());
  });
  assert.equal((await reader.inspect(binding, signal())).ok, true);
  assert.ok(headers.every(h => h.get("Stripe-Account") === null));
});

test("Stripe foreign or incomplete Session/Intent/Charge evidence cannot confirm money", async () => {
  const faults: ((s: ReturnType<typeof session>) => void)[] = [
    s => { s.id = "cs_test_foreign"; }, s => { s.mode = "subscription"; }, s => { s.livemode = true; },
    s => { s.client_reference_id = "foreign-action"; }, s => { s.amount_total = 2499; }, s => { s.currency = "gbp"; },
    s => { s.status = "open"; }, s => { s.payment_status = "no_payment_required"; },
    s => { s.payment_intent.amount_received = 0; }, s => { s.payment_intent.status = "processing"; },
    s => { s.payment_intent.livemode = true; }, s => { s.payment_intent.currency = "gbp"; }, s => { s.payment_intent.amount = 2501; },
    s => { s.payment_intent.latest_charge.payment_intent = "pi_foreign"; },
    s => { s.payment_intent.latest_charge.amount_captured = 2499; }, s => { s.payment_intent.latest_charge.captured = false; },
    s => { s.payment_intent.latest_charge.paid = false; }, s => { s.payment_intent.latest_charge.livemode = true; },
    s => { s.payment_intent.latest_charge.amount_refunded = 2501; }, s => { s.payment_intent.latest_charge.refunded = true; },
  ];
  for (const fault of faults) { const s = session(); fault(s); assert.equal((await fixture(s).reader.inspect(binding, signal())).ok, false); }
  for (const payment_intent of [null, "pi_unexpanded", {}, { ...intent(), status: ["succeeded"] }, { ...intent(), latest_charge: "ch_unexpanded" }]) {
    assert.equal((await fixture({ ...session(), payment_intent }).reader.inspect(binding, signal())).ok, false);
  }
});

test("Stripe refunded and disputed charges retain separate adjusted truth instead of unqualified paid confirmation", async () => {
  for (const patch of [{ amount_refunded: 100, refunded: false, disputed: false },
    { amount_refunded: 2500, refunded: true, disputed: false }, { amount_refunded: 0, refunded: false, disputed: true }]) {
    const s = session(); Object.assign(s.payment_intent.latest_charge, patch);
    const r = await fixture(s).reader.inspect(binding, signal()); assert.ok(r.ok && r.value.kind === "adjusted");
    assert.equal(r.value.refundedAmount, patch.amount_refunded); assert.equal(r.value.disputed, patch.disputed);
  }
});

test("Stripe expiry evidence requires an expired unpaid session with no live payment intent", async () => {
  for (const status of ["open", "complete", "expired"]) {
    const r = await fixture({ ...session(), status, payment_status: "unpaid", payment_intent: null }).reader.inspect(binding, signal());
    assert.ok(r.ok && r.value.kind === "unpaid"); assert.equal(r.value.paymentClosed, status === "expired");
  }
  for (const status of ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled"]) {
    const s = { ...session(), status: "expired", payment_status: "unpaid", payment_intent: { ...intent(), status, amount_received: 0, latest_charge: null } };
    const r = await fixture(s).reader.inspect(binding, signal()); assert.ok(r.ok);
    if (["requires_action", "processing", "requires_capture"].includes(status)) assert.equal(r.value.kind, "pending");
    else { assert.ok(r.value.kind === "unpaid"); assert.equal(r.value.paymentClosed, status === "canceled"); }
  }
  assert.equal((await fixture({ ...session(), payment_status: "unpaid" }).reader.inspect(binding, signal())).ok, false);
});

test("Stripe failures, malformed bodies and revoked reads return fixed errors without private diagnostics", async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    let canceled = false;
    const reader = new StripeCheckoutReader(config, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from("private-provider-body")); }, cancel() { canceled = true; },
    }), { status }));
    assert.deepEqual(await reader.inspect(binding, signal()), { ok: false, error: { kind: status === 401 || status === 403 ? "forbidden" : "unavailable" } });
    assert.equal(canceled, true, "rejected API responses release their private body without parsing or logging it");
  }
  for (const raw of ["bad JSON", "null", "[]", "x".repeat(1_000_001)]) {
    const reader = new StripeCheckoutReader(config, async () => new Response(raw));
    assert.deepEqual(await reader.inspect(binding, signal()), { ok: false, error: { kind: "malformed" } });
  }
  const reader = new StripeCheckoutReader(config, async () => { throw new Error("private-provider-error"); });
  assert.deepEqual(await reader.inspect(binding, signal()), { ok: false, error: { kind: "unavailable" } });
});

test("Stripe read bounds an ignored fetch abort and held response body, and never accepts late or backwards time", async () => {
  for (const held of ["fetch", "body"] as const) {
    let canceled = false;
    const reader = new StripeCheckoutReader({ ...config, deadlineMs: 20 }, async () => held === "fetch" ? new Promise<Response>(() => {}) :
      new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { canceled = true; } })));
    assert.deepEqual(await reader.inspect(binding, signal()), { ok: false, error: { kind: "unavailable" } });
    if (held === "body") assert.equal(canceled, true);
  }
  for (const end of [now - 1, now + 10_001, NaN]) {
    let n = 0;
    const reader = new StripeCheckoutReader({ ...config, clock: () => n++ === 0 ? now : end }, async (url) =>
      Response.json(String(url).endsWith("/account") ? { object: "account", id: config.accountRef } : session()));
    assert.deepEqual(await reader.inspect(binding, signal()), { ok: false, error: { kind: "unavailable" } });
  }
  const lifetime = new AbortController(); lifetime.abort(); const f = fixture();
  assert.equal((await f.reader.inspect(binding, lifetime.signal)).ok, false); assert.equal(f.calls.length, 0);
});

test("Stripe reader captures an immutable private intent and refuses invalid bindings before any provider call", async () => {
  const mutable = { ...binding }; let calls = 0;
  const reader = new StripeCheckoutReader(config, async url => {
    calls++; mutable.amount = 1; mutable.actionRef = "foreign";
    return Response.json(String(url).endsWith("/account") ? { object: "account", id: config.accountRef } : session());
  });
  const r = await reader.inspect(mutable, signal()); assert.ok(r.ok); assert.equal(r.value.amount, 2500); assert.equal(calls, 2);
  const f = fixture();
  for (const patch of [{ checkoutRef: "https://foreign.test" }, { actionRef: "patient-id" }, { amount: 0 }, { amount: NaN }, { currency: "NZD" }]) {
    assert.deepEqual(await f.reader.inspect({ ...binding, ...patch }, signal()), { ok: false, error: { kind: "invalidBinding" } });
  }
  assert.equal(f.calls.length, 0);
});

test("Stripe evidence allowlists binding fields even when the host intent carries additional patient context", async () => {
  const financialIntent = { ...binding, patient: "private-extra-patient", recipient: "private-extra@example.test" };
  const result = await fixture().reader.inspect(financialIntent, signal()); assert.ok(result.ok);
  assert.doesNotMatch(JSON.stringify(result), /private-extra|patient|recipient/);
});
