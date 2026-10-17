import assert from "node:assert/strict";
import test from "node:test";
import { financialResendFixture, value } from "../support/financial-resend-owner.ts";
for (const purpose of ["linkDelivery", "receiptDelivery"] as const)
  test(`one explicitly approved ${purpose} uses its new approval/effect and preserves original one-use delivery`, async () => {
    const f = await financialResendFixture({ purpose }); if (purpose === "receiptDelivery") f.paid();
    assert.deepEqual(value(await f.resend()), { kind: "accepted" }); assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0]!.ref, f.selected.request.effectRef); assert.equal(f.messages[0]!.mail.purpose, purpose);
    assert.equal(f.burned.has(f.selected.request.approvalRef), true); assert.equal(f.burned.has(f.selected.request.effectRef), true);
    assert.equal(f.burned.has(f.intent.effects[purpose]), false); assert.equal(f.claims <= 180, true);
    const before = f.messages.length; assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, before);
  });
for (const gate of ["denySource", "denyHistory", "denyBinding", "denyMessage", "unadmit", "expireMessageOwner", "denyResend", "denyFinancial", "retireResend"] as const)
  test(`explicit financial resend cannot borrow independent current ${gate}`, async () => {
    const f = await financialResendFixture(); f[gate](); assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 0);
    assert.equal(f.burned.has(f.selected.request.approvalRef), false); assert.equal(f.burned.has(f.selected.request.effectRef), false);
  });
test("received money prevents a stale payment-link resend without changing payment or creating another Checkout", async () => {
  const f = await financialResendFixture(); f.paid(); assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 0);
  assert.equal(f.requests.filter(r => r.method === "POST").length, 1); assert.equal(f.burned.has(f.selected.request.effectRef), false);
});
test("current sender selection and recipient permission remain separate from the native request", async () => {
  for (const changed of ["sender", "recipient"] as const) {
    const f = await financialResendFixture(); if (changed === "sender") f.changeSender(); else f.changeApprovedRecipient();
    assert.equal((await f.resend()).ok, false); assert.equal(f.messages.length, 0); assert.equal(f.burned.has(f.selected.request.effectRef), false);
  }
});
