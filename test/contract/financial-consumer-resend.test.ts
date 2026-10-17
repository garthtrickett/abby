import assert from "node:assert/strict";
import test from "node:test";
import { ClinikoFinancialConsumer } from "../../src/standalone/cliniko-financial-consumer.ts";
import type { FinancialConsumerAuthorities, FinancialConsumerCycle } from "../../src/standalone/cliniko-financial-consumer.ts";
import { financialResendFixture, value, stop } from "../support/financial-resend-owner.ts";
import { secret } from "../support/financial-webhook-handoff.ts";
async function composed(options: Parameters<typeof financialResendFixture>[0] = {}, enable = true) {
  const f = await financialResendFixture(options); value(await f.send()); let live = true;
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  const authority: FinancialConsumerAuthorities = {
    run: { allows: async () => live, current: () => live }, pending: { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => live },
    checkout: f.checkoutAuthority, records: f.recordsAuthority, message: f.authority,
    ...(enable ? { resend: { authority: f.resendAuthority, maximumAuthorityRequests: 0 } } : {}),
    work: { authorizeWork: async () => ({ reviewDate: "2026-11-02" }), providerBindingAuthorized: async q => q.checkoutRef === f.binding.checkoutRef,
      current: () => live, onCheckoutAcknowledged: async () => { throw new Error("No new payable expected"); } },
    webhook: { allowsReferenceRead: async () => true, acceptsExistingPending: async () => true, current: () => live },
  };
  const stripe: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); if (url.pathname === "/v1/checkout/sessions" && init?.method === "GET") {
      const from = Number(url.searchParams.get("created[gte]")), through = Number(url.searchParams.get("created[lte]"));
      return Response.json({ object: "list", url: "/v1/checkout/sessions", has_more: false,
        data: f.sessions.filter(s => Number(s.created) >= from && Number(s.created) <= through) });
    }
    return f.stripePort(input, init);
  };
  let notify: ((cycle: FinancialConsumerCycle) => void) | undefined;
  const consumer = value(ClinikoFinancialConsumer.create({ checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000,
    webhook: { endpointSecret: secret, accountRef: checkout.stripe.accountRef, livemode: false, apiVersion: checkout.stripe.apiVersion, clock: checkout.stripe.clock } }, authority,
  { barrier: f.barrier, delivery: f.delivery, native: f.nativePort, stripe, onCycle: cycle => { const waiting = notify; notify = undefined; waiting?.(cycle); } }));
  const cycle = () => new Promise<FinancialConsumerCycle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic explicit resend cycle unavailable")), 5_000);
    notify = result => { clearTimeout(timer); resolve(result); };
  });
  return { ...f, consumer, cycle, retireRun: () => { live = false; } };
}
test("explicitly provisioned periodic financial host sends one approved request and retains possible-history review on repeat", { timeout: 8_000 }, async t => {
  const f = await composed(); t.after(() => f.consumer.close()); const pending = f.cycle(); value(f.consumer.start(stop()));
  assert.equal((await pending).messageAccepted, 1); assert.equal(f.messages.length, 2);
  const next = await f.cycle(); assert.equal(next.messageAccepted, 0); assert.ok(next.reviewRequired > 0); assert.equal(f.messages.length, 2);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1); assert.equal(f.burned.has(f.selected.request.effectRef), true);
});
test("native prospective request alone cannot enable the consumer resend provision", { timeout: 8_000 }, async t => {
  const f = await composed({}, false); t.after(() => f.consumer.close()); const pending = f.cycle(); value(f.consumer.start(stop()));
  assert.equal((await pending).messageAccepted, 0); assert.equal(f.messages.length, 1); assert.equal(f.burned.has(f.selected.request.effectRef), false);
});
for (const grant of ["allows", "financialAuthorized"] as const)
  test(`periodic financial host needs independent current resend ${grant}`, { timeout: 8_000 }, async t => {
    const f = await composed({ authority: { [grant]: async () => false } }); t.after(() => f.consumer.close());
    const pending = f.cycle(); value(f.consumer.start(stop())); const result = await pending;
    assert.equal(result.messageAccepted, 0); assert.ok(result.reviewRequired > 0); assert.equal(f.messages.length, 1);
    assert.equal(f.burned.has(f.selected.request.approvalRef), false); assert.equal(f.burned.has(f.selected.request.effectRef), false);
  });
test("consumer lifetime permission withdrawn during request approval prevents a later send", { timeout: 8_000 }, async t => {
  let retire = () => {}; const f = await composed({ authority: { allows: async () => { retire(); return true; } } }); retire = f.retireRun;
  t.after(() => f.consumer.close()); const pending = f.cycle(); value(f.consumer.start(stop()));
  assert.equal((await pending).messageAccepted, 0); assert.equal(f.messages.length, 1); assert.equal(f.burned.has(f.selected.request.effectRef), false);
});
