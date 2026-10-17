import assert from "node:assert/strict";
import test from "node:test";
import { caseClassExpiryFixture, value, stop } from "../support/financial-case-class-expiry.ts";
import { ClinikoFinancialConsumer } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { FinancialConsumerAuthorities, FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";
import { secret } from "../support/financial-webhook-handoff.ts";

async function composed(options: Parameters<typeof caseClassExpiryFixture>[0] = {}, enable = true) {
  const f = await caseClassExpiryFixture(options);
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  const authority: FinancialConsumerAuthorities = {
    run: { allows: async () => true, current: () => true },
    pending: { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true },
    checkout: f.checkoutAuthority, records: f.recordsAuthority, message: f.authority, checkoutExpiry: f.expiryAuthority,
    ...(enable ? { caseClassClinicalExpiry: { authority: f.caseAuthority, classPolicy: f.classPolicy, maximumAuthorityRequests: 0 } } : {}),
    work: { authorizeWork: async () => ({ reviewDate: "2026-11-02" }), providerBindingAuthorized: async q => q.checkoutRef === f.binding.checkoutRef,
      current: () => true, onCheckoutAcknowledged: async () => { throw new Error("No new payable expected"); } },
    webhook: { allowsReferenceRead: async () => true, acceptsExistingPending: async () => true, current: () => true },
  };
  let notify: ((cycle: FinancialConsumerCycle) => void) | undefined;
  const consumer = value(ClinikoFinancialConsumer.create({ checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000,
    webhook: { endpointSecret: secret, accountRef: checkout.stripe.accountRef, livemode: false, apiVersion: checkout.stripe.apiVersion, clock: checkout.stripe.clock } }, authority,
  { barrier: f.barrier, delivery: f.delivery, native: f.caseNative, stripe: f.expiryStripePort, onCycle: c => { const waiting = notify; notify = undefined; waiting?.(c); } }));
  const cycle = () => new Promise<FinancialConsumerCycle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bounded synthetic clinical expiry cycle unavailable")), 5_000);
    notify = c => { clearTimeout(timer); resolve(c); };
  });
  return { ...f, consumer, cycle };
}
test("provisioned periodic class expiry cancels one exact closed-unpaid case-linked attendee without another Checkout or message", async t => {
  const f = await composed(); t.after(async () => { await f.consumer.close(); await f.close(); }); const pending = f.cycle(); value(f.consumer.start(stop()));
  const first = await pending; assert.equal(first.clinicalExpiryCancelled, 1); assert.equal(first.checkoutExpiryAcknowledged, 0);
  assert.equal(f.cancellations.length, 1); assert.equal(f.posts.length, 0); assert.equal(f.messages.length, 0);
  assert.equal((await f.cycle()).reviewRequired, 1); assert.equal(f.cancellations.length, 1);
});
test("Checkout expiry provisioning alone cannot supply case-linked class clinical permission", async t => {
  const f = await composed({}, false); t.after(async () => { await f.consumer.close(); await f.close(); }); const pending = f.cycle(); value(f.consumer.start(stop()));
  const result = await pending; assert.equal(result.checkoutClosedUnpaid, 1); assert.equal(result.clinicalExpiryCancelled, 0); assert.equal(f.cancellations.length, 0);
});
for (const gate of ["financialAuthorized", "producerAdmitted", "clinicalApproval"] as const)
  test(`actual class consumer refuses separate current ${gate}`, async t => {
    const f = await composed({ authority: gate === "clinicalApproval" ? { clinicalApproval: async () => null } : { [gate]: async () => false } });
    t.after(async () => { await f.consumer.close(); await f.close(); }); const pending = f.cycle(); value(f.consumer.start(stop()));
    const result = await pending; assert.equal(result.reviewRequired, 1); assert.equal(result.clinicalExpiryCancelled, 0); assert.equal(f.cancellations.length, 0);
  });
