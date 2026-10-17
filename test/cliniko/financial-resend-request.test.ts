import assert from "node:assert/strict";
import test from "node:test";
import { encodeFinancialResendRequest, decodeFinancialResendRequest, resendRequestMatchesIntent } from "../../src/cliniko/financial-resend-request.ts";
import type { FinancialResendRequest } from "../../src/cliniko/financial-resend-request.ts";
import { financialMessageSelectionDigest } from "../../src/standalone/smtp-financial-message-delivery.ts";
import { intentValue, uuid, now, value } from "../support/financial-retention.ts";
import { resendSelection as selection, resendRequestValue as request } from "../support/financial-resend.ts";
for (const purpose of ["linkDelivery", "receiptDelivery"] as const) test(`bounded canonical ${purpose} resend context is separate from the original effects`, () => {
  const a = { ...request(), purpose }, encoded = value(encodeFinancialResendRequest(a)), decoded = value(decodeFinancialResendRequest(encoded));
  assert.deepEqual(decoded, a); assert.equal(Object.isFrozen(decoded), true); assert.ok(encoded.length <= 1_050);
  assert.equal(resendRequestMatchesIntent(decoded, intentValue(), a.intentRecallRef), true);
  assert.equal(encoded.includes(intentValue().recipient.address), false); assert.equal(encoded.includes("https://"), false);
  assert.equal(decodeFinancialResendRequest(encoded + "\n").ok, false);
  assert.equal(decodeFinancialResendRequest(encoded.replace('["', '[ "')).ok, false);
});
for (const patch of [{ purpose: "refund" }, { effectRef: uuid(100) }, { approvalRef: uuid(101) }, { intentRecallRef: "cliniko:recall:31" },
  { checkoutAttemptActionRef: uuid(8) }, { targetRef: "cliniko:patient:21" }, { checkoutRef: "https://checkout.stripe.com/private" },
  { selectionDigest: "not-a-digest" }, { requestedAt: "2026-11-01T10:00:00Z" }, { expiresAt: now },
  { expiresAt: "2026-11-02T10:00:00.001Z" }, { expiresAt: "2026-11-31T10:00:00.000Z" }, { unknown: "private" }])
  test(`malformed resend ${Object.keys(patch)[0]} refuses without truncation or coercion`, () => {
    assert.equal(encodeFinancialResendRequest({ ...request(), ...patch } as FinancialResendRequest).ok, false);
  });
for (const change of ["patient", "recipient", "amount", "business", "account", "class", "intentRef", "oldEffect", "oldAction", "tooEarly"] as const)
  test(`resend cannot borrow another ${change} context or original effect`, () => {
    const a = request(); let intent = intentValue(); let ref = a.intentRecallRef;
    if (change === "patient") intent = { ...intent, patientId: "22" };
    if (change === "recipient") intent = { ...intent, recipient: { ...intent.recipient, address: "other@example.test" } };
    if (change === "amount") intent = { ...intent, payment: { ...intent.payment, amount: 5001 } };
    if (change === "business") intent = { ...intent, businessId: "12" };
    if (change === "account") intent = { ...intent, stripe: { ...intent.stripe, accountRef: "acct_other" } };
    if (change === "class") intent = { ...intent, booking: { ...intent.booking, kind: "classBook", sessionId: "91" } };
    if (change === "intentRef") ref = "cliniko:recall:40";
    const candidate = change === "oldEffect" ? { ...a, effectRef: intent.effects.linkDelivery }
      : change === "oldAction" ? { ...a, approvalRef: intent.booking.actionRef }
      : change === "tooEarly" ? { ...a, requestedAt: "2026-11-01T08:59:59.999Z" } : a;
    assert.equal(resendRequestMatchesIntent(candidate, intent, ref), false);
  });
test("valid long opaque provider ID survives without truncation", () => {
  const a = { ...request(), checkoutRef: `cs_test_${"x".repeat(200)}` };
  assert.equal(value(decodeFinancialResendRequest(value(encodeFinancialResendRequest(a)))).checkoutRef, a.checkoutRef);
  assert.equal(encodeFinancialResendRequest({ ...a, checkoutRef: a.checkoutRef + "x" }).ok, false);
});
test("sender selection digest binds its exact approved fields and ignores property order", () => {
  const digest = financialMessageSelectionDigest(selection); assert.match(digest!, /^[a-f0-9]{64}$/);
  assert.equal(financialMessageSelectionDigest({ timeZone: selection.timeZone, template: selection.template, sender: selection.sender }), digest);
  assert.notEqual(financialMessageSelectionDigest({ ...selection, sender: "other@example.test" }), digest);
  assert.equal(financialMessageSelectionDigest({ ...selection, sender: "bad\r\nsender@example.test" }), undefined);
});
