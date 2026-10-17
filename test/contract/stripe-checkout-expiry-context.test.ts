import assert from "node:assert/strict";
import test from "node:test";
import { expiryFixture, value, stop } from "../support/financial-checkout-expiry.ts";
import { StripeCheckoutCorrelationReader } from "../../src/stripe/checkout-correlation.ts";

test("expiry settings remain private context and reference-only reads never disclose status, deadline, money or URL", async () => {
  const f = await expiryFixture(), reader = new StripeCheckoutCorrelationReader(f.config.stripe, f.expiryStripePort);
  const expiry = value(await reader.readExpiry(f.binding.checkoutRef, stop()));
  assert.equal(expiry.status, "open"); assert.equal(expiry.expiresAt, f.intent.payment.deadline); assert.equal("url" in expiry, false);
  const ordinary = value(await reader.read(f.binding.checkoutRef, stop()));
  for (const field of ["status", "expiresAt", "payment_status", "url"]) assert.equal(field in ordinary, false);
});

for (const patch of [{ status: ["open"] }, { status: null }, { status: "pending" }, { expires_at: "1793606400" },
  { expires_at: 0 }, { expires_at: Number.MAX_SAFE_INTEGER }])
test("expiry context rejects malformed provider settings before financial authority can consume them", async () => {
  const f = await expiryFixture(); Object.assign(f.sessions[0]!, patch);
  assert.equal((await new StripeCheckoutCorrelationReader(f.config.stripe, f.expiryStripePort).readExpiry(f.binding.checkoutRef, stop())).ok, false);
  assert.equal(f.posts.length, 0);
});
