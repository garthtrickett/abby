import assert from "node:assert/strict";
import test from "node:test";
import { clinicalExpiryFixture, value, stop } from "../support/financial-clinical-expiry.ts";
import { decodeFinancialExpiryAttempt } from "../../src/cliniko/financial-expiry-attempt.ts";
import { intentValue } from "../support/financial-retention.ts";

function attempts(f: Awaited<ReturnType<typeof clinicalExpiryFixture>>) {
  return [...f.rows.values()].flatMap(row => { const decoded = decodeFinancialExpiryAttempt(row.notes); return decoded.ok ? [decoded.value] : []; });
}
test("independently approved individual expiry retains native possible-review and preserves cancellation's own inspected outcome", async () => {
  const f = await clinicalExpiryFixture();
  assert.deepEqual(value(await f.expireClinical()), { kind: "cancelled", money: "unpaid", reviewRequired: false });
  assert.equal(f.cancellations.length, 1); assert.equal(f.posts.length, 0, "no Stripe/PaymentIntent write");
  assert.equal(attempts(f).length, 1); assert.equal(attempts(f)[0]!.purpose, "clinicalExpiry");
  assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), false, "clinical permission is separate from Checkout expiry");
  assert.equal((await f.expireClinical()).ok, false); assert.equal((await value(f.makeClinical()).expireOnce(f.binding, stop())).ok, false);
  assert.equal(f.cancellations.length, 1);
});
for (const gate of ["denySource", "denyHistory", "denyReference", "denyProvider", "denyFinancial", "denyClinical", "denyProducer", "retire"] as const)
  test(`closed-unpaid Stripe context cannot bypass current ${gate}`, async () => {
    const f = await clinicalExpiryFixture(); f[gate]();
    assert.equal((await f.expireClinical()).ok, false); assert.equal(f.cancellations.length, 0);
    assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false); assert.equal(attempts(f).length, 0);
  });
for (const change of [{ approvedTerms: "Different expiry terms." }, { timeZone: "Australia/Sydney" }, { policyVersion: "fees-2" }, { termsVersion: "terms-2" }])
  test(`expiry refuses changed captured financial approval ${Object.keys(change)[0]}`, async () => {
    const f = await clinicalExpiryFixture(); f.changeApproval(change);
    assert.equal((await f.expireClinical()).ok, false); assert.equal(f.cancellations.length, 0); assert.equal(attempts(f).length, 0);
  });
test("legacy producer booking observation without played financial consent cannot authorize clinical expiry", async () => {
  const f = await clinicalExpiryFixture({ legacyConsent: true });
  assert.equal((await f.expireClinical()).ok, false); assert.equal(f.cancellations.length, 0);
});
test("class/pass cancellation never borrows the individual financial expiry writer", async () => {
  const i = intentValue(), f = await clinicalExpiryFixture({ checkout: { native: { intent: { ...i, booking: { ...i.booking, kind: "classBook", sessionId: "51" } } } } });
  assert.equal((await f.expireClinical()).ok, false); assert.equal(f.cancellations.length, 0); assert.equal(attempts(f).length, 0);
});
for (const state of ["paid", "open", "processing", "authorized", "cancelled", "changed"] as const)
  test(`clinical expiry refuses ${state} financial or target state`, async () => {
    const f = await clinicalExpiryFixture();
    if (state === "paid") f.paid();
    if (state === "open") { f.sessions[0]!.status = "open"; f.sessions[0]!.url = "https://checkout.stripe.com/c/pay/private"; }
    if (state === "processing" || state === "authorized") f.sessions[0]!.payment_intent = { object: "payment_intent", id: "pi_expiry", livemode: false,
      amount: f.intent.payment.amount, currency: f.intent.payment.currency, amount_received: 0, status: state === "processing" ? "processing" : "requires_capture" };
    if (state === "cancelled") f.appointment.cancelled_at = f.config.cliniko.clock!();
    if (state === "changed") f.appointment.starts_at = "2026-11-03T09:10:00.000Z";
    assert.equal((await f.expireClinical()).ok, false); assert.equal(f.cancellations.length, 0);
  });
test("payment winning after possible native expiry review prevents clinical dispatch", async () => {
  let f!: Awaited<ReturnType<typeof clinicalExpiryFixture>>;
  f = await clinicalExpiryFixture({ retained: () => { f.paid(); } });
  assert.equal((await f.expireClinical()).ok, false); assert.equal(f.cancellations.length, 0);
  assert.equal(attempts(f).length, 1); assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), true);
});
test("a lost possible clinical send cannot retry after local exclusion loss and native attempt closure", async () => {
  const f = await clinicalExpiryFixture({ cancel: () => { throw new Error("synthetic lost cancellation response"); } });
  assert.deepEqual(value(await f.expireClinical()), { kind: "uncertain", money: "unpaid", reviewRequired: true });
  assert.equal(f.cancellations.length, 1); f.burned.clear();
  const row = [...f.rows.values()].find(r => decodeFinancialExpiryAttempt(r.notes).ok)!;
  row.recalled_at = f.config.cliniko.clock!(); row.archived_at = f.config.cliniko.clock!();
  assert.equal((await value(f.makeClinical()).expireOnce(f.binding, stop())).ok, false); assert.equal(f.cancellations.length, 1);
});
test("an acknowledged cancellation and late received money stay separate and require clinic review without restoration", async () => {
  let f!: Awaited<ReturnType<typeof clinicalExpiryFixture>>;
  f = await clinicalExpiryFixture({ cancel: row => { row.cancelled_at = f.config.cliniko.clock!(); row.cancellation_reason = 50; f.paid(); return new Response(null, { status: 204 }); } });
  assert.deepEqual(value(await f.expireClinical()), { kind: "cancelled", money: "received", reviewRequired: true });
  assert.equal(f.cancellations.length, 1); assert.equal(f.posts.length, 0);
});

test("shared financial readback preserves the previous producer's signed clip bytes", async () => {
  const { financialConsentReadback, financialConsentDigest } = await import("../../src/standalone/financial-consent-readback.ts");
  const { approvedTerms } = await import("../support/financial-clinical-expiry.ts");
  const clips = financialConsentReadback(intentValue(), approvedTerms, "Etc/UTC")!;
  assert.equal(clips.length, 4);
  // Captured from c562363's original private formatter, before extraction.
  assert.equal(financialConsentDigest(clips), "ba02658b58fb6f561b59b3ad7796edd4cf00c60d1b6d5a61dffb0299d0de1664");
});

for (const gate of ["denySource", "denyReference", "denyProvider", "denyFinancial", "denyClinical", "denyProducer", "retire"] as const)
  test(`authority loss after native possible-expiry review stops clinical send: ${gate}`, async () => {
    let f!: Awaited<ReturnType<typeof clinicalExpiryFixture>>;
    f = await clinicalExpiryFixture({ retained: () => { f[gate](); } });
    assert.equal((await f.expireClinical()).ok, false); assert.equal(attempts(f).length, 1);
    assert.equal(f.cancellations.length, 0); assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), true);
  });
test("changed native target during final preparation refuses clinical expiry without a PATCH", async () => {
  let retained = false;
  const f = await clinicalExpiryFixture({ retained: () => { retained = true; }, read: row => { if (retained) row.ends_at = "2026-11-03T09:45:00.000Z"; } });
  assert.equal((await f.expireClinical()).ok, false); assert.equal(f.cancellations.length, 0); assert.equal(attempts(f).length, 1);
});
test("closing the possible native review during the writer's target preparation prevents a late clinical PATCH", async () => {
  let f!: Awaited<ReturnType<typeof clinicalExpiryFixture>>;
  f = await clinicalExpiryFixture({ read: (_row, count) => {
    if (count === 3) { const record = [...f.rows.values()].find(r => decodeFinancialExpiryAttempt(r.notes).ok)!; record.recalled = true; }
  } });
  assert.equal((await f.expireClinical()).ok, false); assert.equal(f.cancellations.length, 0);
});
for (const boundary of ["abort", "deadline"] as const)
  test(`a held native clinical read respects ${boundary} and cannot dispatch its late result`, { timeout: 5_000 }, async () => {
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController();
    const f = await clinicalExpiryFixture({ ...(boundary === "deadline" ? { deadlineMs: 250 } : {}), read: async () => { entered(); await held; } });
    try {
      const pending = f.expireClinical(controller.signal);
      assert.equal(await Promise.race([started.then(() => true), pending.then(() => false)]), true, "native read entered before abort boundary");
      if (boundary === "abort") controller.abort();
      assert.equal((await pending).ok, false); assert.equal(f.cancellations.length, 0);
      release(); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.cancellations.length, 0);
    } finally { release(); controller.abort(); }
  });
test("loss of later financial reference permission cannot erase an inspected native cancellation", async () => {
  let f!: Awaited<ReturnType<typeof clinicalExpiryFixture>>;
  f = await clinicalExpiryFixture({ cancel: row => { row.cancelled_at = f.config.cliniko.clock!(); row.cancellation_reason = 50; f.denyReference(); return new Response(null, { status: 204 }); } });
  assert.deepEqual(value(await f.expireClinical()), { kind: "cancelled", money: "unknown", reviewRequired: true });
  assert.equal(f.cancellations.length, 1);
});
