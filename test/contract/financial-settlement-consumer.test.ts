import assert from "node:assert/strict";
import test from "node:test";
import { financialConsumerFixture } from "../support/financial-consumer.ts";
import { clinicalExpiryFixture } from "../support/financial-clinical-expiry.ts";
import { value, base, stop } from "../support/financial-retention.ts";
import { secret } from "../support/financial-webhook-handoff.ts";
import { ClinikoFinancialSettlementReview } from "../../src/standalone/cliniko-financial-settlement-review.ts";
import { createFinancialSettlementConsumer } from "../../src/standalone/financial-settlement-authorities.ts";
import type { FinancialConsumerAuthorities, FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { ClinikoFinancialReviewConfig } from "../../src/cliniko/financial-review-read.ts";
import type { FinancialSettlementContext } from "../../src/standalone/cliniko-financial-settlement-review.ts";

function reviewFixture(config: ClinikoFinancialReviewConfig, native: typeof fetch, state: { status: number; reads: number }) {
  const invoiceNative: typeof fetch = async (input, init) => {
    if (String(input) !== `${base}/invoices/72`) return native(input, init);
    assert.equal(init?.method, "GET"); state.reads++;
    return Response.json({ id: "72", links: { self: `${base}/invoices/72` }, patient: { links: { self: `${base}/patients/21` } },
      business: { links: { self: `${base}/businesses/11` } }, booking: { links: { self: `${base}/bookings/91` } },
      total_amount: "50.00", status: state.status, archived_at: null, deleted_at: null,
      created_at: "2026-11-01T09:00:00.000Z", updated_at: "2026-11-01T09:00:00.000Z" });
  };
  const resolve = async (context: FinancialSettlementContext) => ({ targetRef: context.targetRef, invoice: {
    financialActionRef: context.intent.actionRef, invoiceRef: "72", patientId: context.intent.patientId, bookingId: "91", bookingKind: context.intent.booking.kind,
    expectedTotalMinor: context.intent.payment.amount, currency: context.intent.payment.currency,
    expiresAt: new Date(Date.parse(config.clock!()) + 60_000).toISOString() } });
  return { native: invoiceNative, review: value(ClinikoFinancialSettlementReview.create(config, {
    bindings: { resolve, current: () => true }, invoices: { allows: async () => true, current: () => true }, native: invoiceNative })) };
}

for (const status of [10, 20, 30]) test(`actual consumer invoice ${status} gates new Checkout before its irreversible claim`, async t => {
  const f = await financialConsumerFixture(), state = { status, reads: 0 }, source = reviewFixture(f.config.checkout.cliniko, f.dependencies.native, state);
  const consumer = value(createFinancialSettlementConsumer(f.config, f.authority, source.review, { ...f.dependencies, native: source.native }));
  t.after(async () => { await consumer.close(); await f.consumer.close(); });
  const pending = f.cycle(); value(consumer.start(stop())); const result = await pending;
  assert.ok(state.reads > 0);
  if (status === 10) { assert.equal(result.creationAcknowledged, 1); assert.equal(f.sessions.length, 1); }
  else { assert.equal(result.creationAcknowledged, 0); assert.ok(result.reviewRequired > 0); assert.equal(f.sessions.length, 0);
    assert.equal(f.burned.has(f.intent.effects.checkout), false); }
});

test("receipt delivery is not turned into unpaid collection or vetoed by an unrelated invoice state", async t => {
  const f = await financialConsumerFixture(), state = { status: 10, reads: 0 }, source = reviewFixture(f.config.checkout.cliniko, f.dependencies.native, state);
  const consumer = value(createFinancialSettlementConsumer(f.config, f.authority, source.review, { ...f.dependencies, native: source.native }));
  t.after(async () => { await consumer.close(); await f.consumer.close(); });
  let pending = f.cycle(); value(consumer.start(stop())); assert.equal((await pending).creationAcknowledged, 1);
  f.paid(); state.status = 30; const reads = state.reads; pending = f.cycle(); assert.equal((await pending).messageAccepted, 1);
  assert.equal(state.reads, reads); assert.equal(f.sessions.length, 1); assert.equal(f.messages.length, 1);
});

for (const status of [10, 20]) test(`actual closed-unpaid clinical expiry checks native recorded invoice ${status} before cancellation`, async t => {
  const f = await clinicalExpiryFixture(), state = { status, reads: 0 }, source = reviewFixture(f.config.cliniko, f.clinicalNativePort, state);
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  const authority: FinancialConsumerAuthorities = { run: { allows: async () => true, current: () => true },
    pending: { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true },
    checkout: f.checkoutAuthority, records: f.recordsAuthority, message: f.authority, checkoutExpiry: f.expiryAuthority, clinicalExpiry: f.clinicalAuthority,
    work: { authorizeWork: async () => ({ reviewDate: "2026-11-02" }), providerBindingAuthorized: async () => true,
      current: () => true, onCheckoutAcknowledged: async () => {} },
    webhook: { allowsReferenceRead: async () => true, acceptsExistingPending: async () => true, current: () => true } };
  let notify!: (cycle: FinancialConsumerCycle) => void;
  const result = new Promise<FinancialConsumerCycle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bounded reviewed consumer cycle unavailable")), 5000);
    notify = c => { clearTimeout(timer); resolve(c); };
  });
  const consumer = value(createFinancialSettlementConsumer({ checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000,
    webhook: { endpointSecret: secret, accountRef: checkout.stripe.accountRef, livemode: false, apiVersion: checkout.stripe.apiVersion, clock: checkout.stripe.clock } },
    authority, source.review, { barrier: f.barrier, delivery: f.delivery, native: source.native, stripe: f.expiryStripePort, onCycle: notify }));
  t.after(() => consumer.close()); value(consumer.start(stop())); const first = await result; assert.ok(state.reads > 0);
  assert.equal(first.clinicalExpiryCancelled, status === 10 ? 1 : 0); assert.equal(f.cancellations.length, status === 10 ? 1 : 0);
  if (status === 20) assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), false);
});

test("consumer factory refuses another budget or an unreviewed augmented resend cost before I/O", async t => {
  const f = await financialConsumerFixture(), state = { status: 10, reads: 0 }, source = reviewFixture(f.config.checkout.cliniko, f.dependencies.native, state);
  t.after(() => f.consumer.close());
  const foreign = { ...f.config, checkout: { ...f.config.checkout, cliniko: { ...f.config.checkout.cliniko, rateBudget: { ...f.config.checkout.cliniko.rateBudget } } } };
  assert.equal(createFinancialSettlementConsumer(foreign, f.authority, source.review, f.dependencies).ok, false);
  const grants = { ...f.authority, resend: { maximumAuthorityRequests: 2,
    authority: { allows: async () => true, financialAuthorized: async () => true, current: () => true } } };
  assert.equal(createFinancialSettlementConsumer(f.config, grants, source.review, f.dependencies).ok, false);
  assert.equal(createFinancialSettlementConsumer(f.config, grants, source.review, f.dependencies, { resend: 2 }).ok, false);
  assert.equal(state.reads, 0);
});
