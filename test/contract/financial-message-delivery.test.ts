import assert from "node:assert/strict";
import test from "node:test";
import { financialMessageFixture, value, stop } from "../support/financial-message-owner.ts";
import { withSmtpVerificationServer } from "../support/smtp-verification-server.ts";
import { SmtpFinancialMessageDelivery, financialMessageDigest } from "../../src/standalone/smtp-financial-message-delivery.ts";
import { StripeCheckoutCorrelationReader } from "../../src/stripe/checkout-correlation.ts";

test("explicit private Checkout link read keeps ordinary correlation reference-only", async () => {
  const f = await financialMessageFixture(), reader = new StripeCheckoutCorrelationReader(f.config.stripe, f.stripePort);
  const link = value(await reader.readLink(f.binding.checkoutRef, stop())); assert.equal(link.kind, "linkContext");
  assert.equal(link.url, "https://checkout.stripe.com/c/pay/cs_test_owner#private-checkout-token");
  const reference = value(await reader.read(f.binding.checkoutRef, stop()));
  assert.equal("url" in reference, false); assert.equal("payment_status" in reference, false); assert.equal("email" in reference, false);
  f.paid(); assert.equal((await reader.readLink(f.binding.checkoutRef, stop())).ok, false);
});

for (const url of ["https://foreign.invalid/c/pay/cs_test_owner", "https://checkout.stripe.com/c/pay/cs_test_foreign",
  "https://user:private@checkout.stripe.com/c/pay/cs_test_owner", "https://checkout.stripe.com/c/pay/cs_test_owner?private=1",
  "https://checkout.stripe.com/c/pay/cs_test_owner\n#token", "javascript:private"]) test("private link capability rejects a foreign or malformed destination", async () => {
  const f = await financialMessageFixture(); f.sessions[0]!.url = url;
  assert.equal((await f.send()).ok, false); assert.equal(f.messages.length, 0); assert.equal(f.burned.has(f.intent.effects.linkDelivery), false);
});

test("actual retained financial link and receipt use real TLS SMTP and separate opaque Message-IDs", async () => {
  await withSmtpVerificationServer(async smtp => {
    const transport = new SmtpFinancialMessageDelivery(smtp.config, "Australia/Sydney");
    const f = await financialMessageFixture({ send: transport.send.bind(transport) });
    assert.deepEqual(value(await f.send()), { kind: "accepted" });
    f.paid(); assert.deepEqual(value(await f.send("receiptDelivery")), { kind: "accepted" });
    assert.equal(smtp.messages.length, 2);
    assert.match(smtp.messages[0]!, /Subject: Your clinic payment link/); assert.match(smtp.messages[0]!, /GBP 50\.00/);
    assert.ok(smtp.messages[0]!.includes(`<${f.intent.effects.linkDelivery}@example.test>`));
    assert.ok(smtp.messages[1]!.includes(`<${f.intent.effects.receiptDelivery}@example.test>`));
    assert.match(smtp.messages[1]!, /https:\/\/pay\.stripe\.com\/receipts\/private-message-receipt/);
    assert.doesNotMatch(smtp.messages.join(""), /cliniko:recall|cliniko:appointment|Abby request|private-move/);
    assert.equal((await f.send("receiptDelivery")).ok, false); assert.equal(smtp.messages.length, 2);
  });
});

test("lost real SMTP acknowledgement retains an unknown result and cannot be blindly resent", async () => {
  await withSmtpVerificationServer(async smtp => {
    smtp.fault("dropAfterData"); const transport = new SmtpFinancialMessageDelivery(smtp.config, "Australia/Sydney");
    const f = await financialMessageFixture({ send: transport.send.bind(transport) });
    assert.deepEqual(value(await f.send()), { kind: "unknown" }); assert.equal(smtp.messages.length, 1);
    assert.equal((await f.send()).ok, false); assert.equal(smtp.messages.length, 1);
  });
});

test("fixed financial rendering rejects arbitrary content, currency assumptions and unsafe receipt URLs", () => {
  const selected = { sender: "clinic@example.test", template: "clinicFinancial.v1" as const, timeZone: "Australia/Sydney" };
  const message = { purpose: "receiptDelivery" as const, email: "patient@example.invalid", amount: 2500, currency: "gbp", url: "https://pay.stripe.com/receipts/exact" };
  assert.match(financialMessageDigest(selected, message)!, /^[a-f0-9]{64}$/);
  for (const patch of [{ currency: "jpy" }, { url: "https://foreign.invalid/receipts/exact" }, { amount: 1.5 },
    { email: "patient@example.invalid\r\nBcc: foreign@example.invalid" }, { subject: "arbitrary subject" }]) {
    assert.equal(financialMessageDigest(selected, { ...message, ...patch }), undefined);
  }
});
