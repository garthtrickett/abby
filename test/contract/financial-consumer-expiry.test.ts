import assert from "node:assert/strict";
import test from "node:test";
import { expiryFixture, value, stop } from "../support/financial-checkout-expiry.ts";
import { ClinikoFinancialConsumer } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { FinancialConsumerAuthorities, FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";
import { secret } from "../support/financial-webhook-handoff.ts";

async function composed(options: Parameters<typeof expiryFixture>[0] = {}, enable = true) {
  const f = await expiryFixture(options);
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  const authority: FinancialConsumerAuthorities = {
    run: { allows: async () => true, current: () => true },
    pending: { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true },
    checkout: f.checkoutAuthority, records: f.recordsAuthority, message: f.authority,
    work: { authorizeWork: async () => ({ reviewDate: "2026-11-02" }),
      // Fixture binding is independently known from its actual creation ACK.
      providerBindingAuthorized: async q => q.checkoutRef === f.binding.checkoutRef, current: () => true,
      onCheckoutAcknowledged: async () => { throw new Error("Unexpected second Checkout"); } },
    webhook: { allowsReferenceRead: async () => true, acceptsExistingPending: async () => true, current: () => true },
    ...(enable ? { checkoutExpiry: f.expiryAuthority } : {}),
  };
  let waiting: ((cycle: FinancialConsumerCycle) => void) | undefined;
  const consumer = value(ClinikoFinancialConsumer.create({ checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000,
    webhook: { endpointSecret: secret, accountRef: checkout.stripe.accountRef, livemode: false,
      apiVersion: checkout.stripe.apiVersion, clock: checkout.stripe.clock } }, authority,
  { barrier: f.barrier, delivery: f.delivery, native: f.nativePort, stripe: f.expiryStripePort,
    onCycle: cycle => { const notify = waiting; waiting = undefined; notify?.(cycle); } }));
  const cycle = () => new Promise<FinancialConsumerCycle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic expiry cycle unavailable")), 12_000);
    waiting = c => { clearTimeout(timer); resolve(c); };
  });
  return { ...f, consumer, cycle, start: () => value(consumer.start(stop())) };
}

test("actual provisioned periodic consumer expires one overdue Session and later observes closed-unpaid without clinical writes", async t => {
  const f = await composed(); t.after(() => f.consumer.close()); const first = f.cycle(); f.start();
  assert.equal((await first).checkoutExpiryAcknowledged, 1); assert.equal(f.posts.length, 1); assert.equal(f.messages.length, 0);
  assert.equal((await f.cycle()).checkoutClosedUnpaid, 1); assert.equal(f.posts.length, 1);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});

test("a host without separate expiry provisioning leaves overdue financial work in review", async t => {
  const f = await composed({}, false); t.after(() => f.consumer.close()); const first = f.cycle(); f.start();
  assert.equal((await first).reviewRequired, 1); assert.equal(f.posts.length, 0); assert.equal(f.messages.length, 0);
});

test("manual-paid/waived current clinic refusal reaches the actual consumer before any expiry effect", async t => {
  const f = await composed({ authority: { expiryAuthorized: async () => false } }); t.after(() => f.consumer.close());
  const first = f.cycle(); f.start(); assert.equal((await first).reviewRequired, 1);
  assert.equal(f.posts.length, 0); assert.equal(f.burned.has(f.intent.effects.checkoutExpiry), false);
});

test("payment winning the consumer expiry race leads only to independently approved receipt delivery on the next poll", async t => {
  let paid = () => {};
  const f = await composed({ post: () => { paid(); return Response.json({ error: "Already completed" }, { status: 400 }); } }); paid = f.paid;
  t.after(() => f.consumer.close()); const first = f.cycle(); f.start(); assert.equal((await first).reviewRequired, 1);
  assert.equal(f.posts.length, 1); assert.equal(f.messages.length, 0);
  assert.equal((await f.cycle()).messageAccepted, 1); assert.equal(f.messages.length, 1); assert.equal(f.messages[0]!.mail.purpose, "receiptDelivery");
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1);
});
