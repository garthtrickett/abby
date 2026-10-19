import assert from "node:assert/strict";
import test from "node:test";
import { caseClassExpiryFixture, value, stop } from "../support/financial-case-class-expiry.ts";
import { unlinkedClassExpiryFixture } from "../support/financial-unlinked-class-expiry.ts";
import { financialResendFixture } from "../support/financial-resend-owner.ts";
import { settlementNative } from "../support/financial-settlement-native.ts";
import { secret } from "../support/financial-webhook-handoff.ts";
import { createFinancialSettlementConsumer } from "../../src/standalone/financial-settlement-authorities.ts";
import type { FinancialConsumerAuthorities, FinancialConsumerCycle, FinancialConsumerConfig } from "../../src/standalone/cliniko-financial-consumer.ts";

type CycleFixture = Awaited<ReturnType<typeof unlinkedClassExpiryFixture>>;
function grants(f: CycleFixture): FinancialConsumerAuthorities {
  return { run: { allows: async () => true, current: () => true },
    pending: { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true },
    checkout: f.checkoutAuthority, records: f.recordsAuthority, message: f.authority,
    work: { authorizeWork: async () => ({ reviewDate: "2026-11-02" }), providerBindingAuthorized: async () => true,
      current: () => true, onCheckoutAcknowledged: async () => { throw new Error("No new payable expected"); } },
    webhook: { allowsReferenceRead: async () => true, acceptsExistingPending: async () => true, current: () => true } };
}
function config(f: { checkoutConfig: FinancialConsumerConfig["checkout"]; config: { cliniko: FinancialConsumerConfig["checkout"]["cliniko"]; stripe: FinancialConsumerConfig["checkout"]["stripe"] } }): FinancialConsumerConfig {
  const checkout = { ...f.checkoutConfig, cliniko: f.config.cliniko, stripe: f.config.stripe };
  return { checkout, pollEveryMs: 1000, cycleDeadlineMs: 10_000, webhook: { endpointSecret: secret,
    accountRef: checkout.stripe.accountRef, livemode: false, apiVersion: checkout.stripe.apiVersion, clock: checkout.stripe.clock } };
}
function cycle() {
  let notify!: (result: FinancialConsumerCycle) => void;
  const done = new Promise<FinancialConsumerCycle>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bounded settlement cycle unavailable")), 5_000);
    notify = result => { clearTimeout(timer); resolve(result); };
  });
  return { done, notify };
}

for (const kind of ["unlinked", "case"] as const) for (const scenario of ["open", "paid", "waived", "partialWaiver", "deniedFinancial", "deniedQuota", "paidBeforeClaim", "paidAfterClaim"] as const)
test(`actual reviewed ${kind} class consumer preserves native settlement ${scenario}`, async t => {
  const f = kind === "case" ? await caseClassExpiryFixture() : await unlinkedClassExpiryFixture(); t.after(f.close);
  const native = "caseNative" in f ? f.caseNative : f.classNative;
  const source = await settlementNative(f.config.cliniko, f.intent, native); t.after(source.close);
  if (scenario === "paid") source.state.status = 20;
  if (scenario === "waived" || scenario === "partialWaiver") source.state.waived = true;
  if (scenario === "partialWaiver") source.state.waiverAmount = 1000;
  if (scenario === "deniedFinancial") f.denyFinancial();
  if (scenario === "deniedQuota") Object.assign(f.config.cliniko.rateBudget, { checkHeadroom: async () => ({ kind: "rateLimited" as const, retryAfterMs: 60_000 }) });
  if (scenario === "paidBeforeClaim") source.state.changeAfterInvoice = 2;
  if (scenario === "paidAfterClaim") source.state.changeAfterInvoice = 3;
  // Six #prepare sites each call the augmented financial grant once. The
  // independent fixture grants/mapping/issuer use no native HTTP. A positive
  // waiver stops at its first check (one invoice + one waiver). This six-call
  // bound is for these explicit ports, never a default for other host grants.
  const authority: FinancialConsumerAuthorities = { ...grants(f), ...("caseAuthority" in f ? {
    caseClassClinicalExpiry: { authority: f.caseAuthority, classPolicy: f.classPolicy, maximumAuthorityRequests: 0 },
  } : { classClinicalExpiry: { authority: f.classAuthority, classPolicy: f.classPolicy } }) };
  const observed = cycle(), consumer = value(createFinancialSettlementConsumer(config(f), authority, source.review,
    { barrier: f.barrier, delivery: f.delivery, native: source.native, stripe: f.expiryStripePort, onCycle: observed.notify },
    kind === "case" ? { caseClassClinicalExpiry: 6 } : {}));
  t.after(() => consumer.close()); value(consumer.start(stop())); const result = await observed.done; await consumer.close();
  assert.equal(result.clinicalExpiryCancelled, scenario === "open" ? 1 : 0);
  assert.equal(f.cancellations.length, scenario === "open" ? 1 : 0);
  assert.equal(source.state.invoiceReads > 0, scenario !== "deniedFinancial");
  assert.ok(source.state.invoiceReads <= 6);
  assert.equal(source.state.waiverReads, scenario === "waived" || scenario === "partialWaiver" ? 1 : 0);
  assert.equal(f.burned.has(f.intent.effects.clinicalExpiry), scenario === "open" || scenario === "paidAfterClaim");
  if (scenario === "open") assert.equal(source.state.invoiceReads, 6);
});

for (const scenario of ["open", "paid", "waived", "partialWaiver", "deniedFinancial", "deniedQuota", "paidAfterClaim", "receipt"] as const)
test(`actual reviewed consumer resend respects ${scenario} without new Checkout`, async t => {
  const f = await financialResendFixture({ purpose: scenario === "receipt" ? "receiptDelivery" : "linkDelivery" });
  if (scenario === "receipt") f.paid(); value(await f.send(scenario === "receipt" ? "receiptDelivery" : "linkDelivery"));
  const source = await settlementNative(f.config.cliniko, f.intent, f.nativePort); t.after(source.close);
  if (scenario === "paid" || scenario === "receipt") source.state.status = 20;
  if (scenario === "waived" || scenario === "partialWaiver") source.state.waived = true;
  if (scenario === "partialWaiver") source.state.waiverAmount = 1000;
  if (scenario === "deniedFinancial") f.denyFinancial();
  if (scenario === "deniedQuota") Object.assign(f.config.cliniko.rateBudget, { checkHeadroom: async () => ({ kind: "rateLimited" as const, retryAfterMs: 60_000 }) });
  if (scenario === "paidAfterClaim") source.state.changeAfterInvoice = 6;
  const authority: FinancialConsumerAuthorities = { run: { allows: async () => true, current: () => true },
    pending: { allowsPendingRead: async () => true, allowsRecordRead: async () => true, current: () => true },
    checkout: f.checkoutAuthority, records: f.recordsAuthority, message: f.authority,
    resend: { authority: f.resendAuthority, maximumAuthorityRequests: 0 },
    work: { authorizeWork: async () => ({ reviewDate: "2026-11-02" }), providerBindingAuthorized: async () => true,
      current: () => true, onCheckoutAcknowledged: async () => { throw new Error("No new payable expected"); } },
    webhook: { allowsReferenceRead: async () => true, acceptsExistingPending: async () => true, current: () => true } };
  const stripe: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); if (url.pathname === "/v1/checkout/sessions" && init?.method === "GET") {
      const from = Number(url.searchParams.get("created[gte]")), through = Number(url.searchParams.get("created[lte]"));
      return Response.json({ object: "list", url: "/v1/checkout/sessions", has_more: false,
        data: f.sessions.filter(s => Number(s.created) >= from && Number(s.created) <= through) });
    }
    return f.stripePort(input, init);
  };
  // Four #permit sites each invoke message and resend financial grants. These
  // exact ports add two invoice reads per permit, at most eight in total.
  // Receipt delivery retains its original financial grants and adds no reads.
  const observed = cycle(), consumer = value(createFinancialSettlementConsumer(config(f), authority, source.review,
    { barrier: f.barrier, delivery: f.delivery, native: source.native, stripe, onCycle: observed.notify }, { resend: 8 }));
  t.after(() => consumer.close()); value(consumer.start(stop())); const result = await observed.done; await consumer.close();
  const sent = scenario === "open" || scenario === "receipt";
  assert.equal(result.messageAccepted, sent ? 1 : 0); assert.equal(f.messages.length, sent ? 2 : 1); assert.equal(f.sessions.length, 1);
  assert.equal(f.burned.has(f.selected.request.effectRef), sent || scenario === "paidAfterClaim");
  assert.equal(f.burned.has(f.selected.request.approvalRef), sent || scenario === "paidAfterClaim");
  // The normal pair first makes one read before finding its already-sent
  // history; the separate resend operation then makes its own eight.
  if (scenario === "open") assert.equal(source.state.invoiceReads, 9);
  if (scenario === "receipt") assert.equal(source.state.invoiceReads, 0);
  assert.ok(source.state.invoiceReads <= 9);
});
