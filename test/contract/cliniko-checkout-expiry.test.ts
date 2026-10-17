import assert from "node:assert/strict";
import test from "node:test";
import { expiryFixture, value, stop, now } from "../support/financial-checkout-expiry.ts";
import { ClinikoFinancialPendingDiscovery } from "../../src/cliniko/financial-pending-discovery.ts";

test("approved overdue Checkout expires once after native attempt and permanent exclusion, with independent closed-unpaid inspection", async () => {
  let beforePost = () => {};
  const f = await expiryFixture({ post: row => { beforePost(); row.status = "expired"; return Response.json(row); } });
  beforePost = () => { assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), true); assert.equal(f.rows.size, 4); };
  assert.deepEqual(value(await f.expireOnce()), { kind: "expiryAcknowledged", money: "closedUnpaid" });
  assert.equal(f.posts.length, 1); assert.equal(f.messages.length, 0); assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
  assert.deepEqual(value(await f.expireOnce()), { kind: "observedClosed", money: "closedUnpaid" }); assert.equal(f.posts.length, 1);
  const pending = value(ClinikoFinancialPendingDiscovery.create(f.config.cliniko,
    { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true }, f.nativePort));
  assert.equal(value(await pending.scanPending(stop())).expiryAttempts?.length, 1);
});

for (const denial of ["beforeDeadline", "denySource", "denyHistory", "denyReference", "denyProvider", "denyExpiry", "denyProducer", "retire"] as const)
test(`${denial} cannot expire an existing unpaid Checkout or consume its one-use expiry effect`, async () => {
  const f = await expiryFixture(); f[denial](); assert.equal((await f.expireOnce()).ok, false);
  assert.equal(f.posts.length, 0); assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), false);
});

test("current manual-payment/waiver refusal is independent of an unpaid Stripe Session", async () => {
  const f = await expiryFixture({ authority: { expiryAuthorized: async () => false } });
  assert.equal((await f.expireOnce()).ok, false); assert.equal(f.posts.length, 0); assert.equal(f.rows.size, 3);
});

test("paid, adjusted, pending, authorized or altered-expiry provider context cannot trigger a financial expiry", async () => {
  for (const state of ["paid", "refunded", "disputed", "processing", "requires_capture", "extended"] as const) {
    const f = await expiryFixture(), session = f.sessions[0]!;
    if (state === "extended") session.expires_at = Number(session.expires_at) + 3600;
    else if (state === "processing" || state === "requires_capture") session.payment_intent = { object: "payment_intent", id: "pi_pending", livemode: false,
      amount: f.intent.payment.amount, currency: f.intent.payment.currency, amount_received: 0, status: state, latest_charge: null };
    else {
      f.paid(); const intent = session.payment_intent as { latest_charge: Record<string, unknown> };
      if (state === "refunded") { intent.latest_charge.amount_refunded = f.intent.payment.amount; intent.latest_charge.refunded = true; }
      if (state === "disputed") intent.latest_charge.disputed = true;
    }
    assert.equal((await f.expireOnce()).ok, false, state); assert.equal(f.posts.length, 0); assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), false);
  }
});

test("payment/native/current changes during retained handoff burn the attempt but cannot reach the expiry POST", async () => {
  for (const change of ["payment", "native", "role", "manualPayment"] as const) {
    let mutate = () => {};
    const f = await expiryFixture({ retained: () => mutate() });
    mutate = () => { if (change === "payment") f.paid(); else if (change === "native") f.rows.get("31")!.recalled = true;
      else if (change === "role") f.retire(); else f.denyExpiry(); };
    assert.equal((await f.expireOnce()).ok, false, change); assert.equal(f.posts.length, 0); assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), true);
  }
});

test("lost expiry ACK is freshly inspected and never blindly replayed after restored missing claims", async () => {
  const f = await expiryFixture({ post: () => { throw new Error("Private uncertain Stripe expiry"); } });
  assert.deepEqual(value(await f.expireOnce()), { kind: "uncertain", money: "unpaid" }); assert.equal(f.posts.length, 1);
  f.burned.delete(f.intent.effects.checkoutExpiry); const row = f.rows.get("33")!; row.recalled = true; row.recalled_at = f.config.cliniko.clock(); row.archived_at = f.config.cliniko.clock();
  assert.deepEqual(await value(f.makeExpiry()).expireOnce(f.binding, stop()), { ok: false, error: { kind: "alreadyClaimed" } }); assert.equal(f.posts.length, 1);
});

test("payment-winning expiry race is received money, never a closed-unpaid or clinical cancellation claim", async () => {
  let paid = () => {};
  const f = await expiryFixture({ post: () => { paid(); return Response.json({ error: { message: "Cannot expire" } }, { status: 400 }); } }); paid = f.paid;
  assert.deepEqual(value(await f.expireOnce()), { kind: "uncertain", money: "received" }); assert.equal(f.posts.length, 1); assert.equal(f.messages.length, 0);
});

test("an observed expiry ACK survives later role loss while withholding further provider reads", async () => {
  let revoke = () => {};
  const f = await expiryFixture({ post: row => { row.status = "expired"; revoke(); return Response.json(row); } }); revoke = f.retire;
  assert.deepEqual(value(await f.expireOnce()), { kind: "expiryAcknowledged", money: "unknown" }); assert.equal(f.posts.length, 1);
});

test("natural closed-unpaid status is only observation and claims no expiry POST", async () => {
  const f = await expiryFixture(); f.naturallyExpired();
  assert.deepEqual(value(await f.expireOnce()), { kind: "observedClosed", money: "closedUnpaid" });
  assert.equal(f.posts.length, 0); assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), false); assert.equal(f.rows.size, 3);
});

test("unknown native retention, held approval and aborted/invalid requests never dispatch expiry", async () => {
  const unknown = await expiryFixture({ retained: () => { throw new Error("Private native ACK loss"); } });
  assert.deepEqual(await unknown.expireOnce(), { ok: false, error: { kind: "attemptUncertain" } }); assert.equal(unknown.posts.length, 0);
  const held = await expiryFixture({ authority: { expiryAuthorized: async () => new Promise<boolean>(() => {}) }, deadlineMs: 30 });
  assert.equal((await held.expireOnce()).ok, false); assert.equal(held.posts.length, 0);
  const f = await expiryFixture(), controller = new AbortController(); controller.abort(); assert.equal((await f.expireOnce(controller.signal)).ok, false);
  assert.equal((await f.expiry.expireOnce({ ...f.binding, checkoutRef: "cs_test_wrong/path" }, stop())).ok, false); assert.equal(f.posts.length, 0);
});
