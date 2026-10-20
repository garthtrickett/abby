import assert from "node:assert/strict";
import test from "node:test";
import { encodeFinancialResendAttempt, decodeFinancialResendAttempt, resendAttemptMatchesRequest } from "../../src/cliniko/financial-resend-attempt.ts";
import type { FinancialResendAttempt } from "../../src/cliniko/financial-resend-attempt.ts";
import { financialResendRequestDigest } from "../../src/cliniko/financial-resend-request.ts";
import { decodeFinancialMessageAttempt } from "../../src/cliniko/financial-message-attempt.ts";
import { resendRequestValue } from "../support/financial-resend.ts";
import { intentValue, uuid, now, value } from "../support/financial-retention.ts";
const requestRef = "cliniko:recall:33";
function attempt(): FinancialResendAttempt {
  const r = resendRequestValue(); return { actionRef: uuid(200), financialActionRef: r.financialActionRef, effectRef: r.effectRef,
    approvalRef: r.approvalRef, requestRecallRef: requestRef, requestActionRef: r.actionRef, requestDigest: financialResendRequestDigest(r)!,
    purpose: r.purpose, intentRecallRef: r.intentRecallRef, intentDigest: r.intentDigest, observationRecallRef: r.observationRecallRef,
    observationActionRef: r.observationActionRef, targetRef: r.targetRef, checkoutRef: r.checkoutRef, payloadDigest: "a".repeat(64), attemptedAt: now };
}
test("possible resend evidence binds the exact request and cannot become an original-delivery attempt", () => {
  const a = attempt(), encoded = value(encodeFinancialResendAttempt(a)), decoded = value(decodeFinancialResendAttempt(encoded));
  assert.deepEqual(decoded, a); assert.equal(Object.isFrozen(decoded), true); assert.equal(decodeFinancialMessageAttempt(encoded).ok, false);
  assert.equal(resendAttemptMatchesRequest(decoded, resendRequestValue(), requestRef, intentValue()), true);
  assert.equal(encoded.includes(intentValue().recipient.address), false); assert.equal(encoded.includes("https://"), false);
  assert.equal(decodeFinancialResendAttempt(encoded.replace('["', '[ "')).ok, false);
});
for (const patch of [{ effectRef: uuid(200) }, { approvalRef: uuid(101) }, { requestRecallRef: "cliniko:recall:30" },
  { requestActionRef: uuid(8) }, { requestDigest: "invalid" }, { payloadDigest: "invalid" }, { purpose: "automaticRetry" },
  { checkoutRef: "https://checkout.stripe.com/private" }, { attemptedAt: "2026-11-31T10:00:00.000Z" }, { extra: "private" }])
  test(`malformed possible resend ${Object.keys(patch)[0]} refuses canonically`, () => {
    assert.equal(encodeFinancialResendAttempt({ ...attempt(), ...patch } as FinancialResendAttempt).ok, false);
  });
for (const patch of [{ effectRef: uuid(4) }, { approvalRef: uuid(201) }, { requestActionRef: uuid(202) }, { requestDigest: "b".repeat(64) },
  { intentDigest: "b".repeat(64) }, { checkoutRef: "cs_test_other" }, { targetRef: "cliniko:appointment:92" }, { purpose: "receiptDelivery" as const },
  { attemptedAt: "2026-11-01T09:59:59.999Z" }, { attemptedAt: "2026-11-01T10:30:00.000Z" }, { actionRef: uuid(2) }])
  test(`possible resend cannot borrow changed ${Object.keys(patch)[0]} or a past/expired request`, () => {
    assert.equal(resendAttemptMatchesRequest({ ...attempt(), ...patch }, resendRequestValue(), requestRef, intentValue()), false);
  });
test("a changed request cannot reuse earlier possible evidence or another patient's original context", () => {
  const a = attempt(), r = resendRequestValue(), i = intentValue();
  for (const changed of [{ ...r, selectionDigest: "f".repeat(64) }, { ...r, checkoutAttemptRecallRef: "cliniko:recall:34" },
    { ...r, expiresAt: "2026-11-01T10:15:00.000Z" }]) assert.equal(resendAttemptMatchesRequest(a, changed, requestRef, i), false);
  assert.equal(resendAttemptMatchesRequest(a, r, "cliniko:recall:34", i), false);
  assert.equal(resendAttemptMatchesRequest(a, r, requestRef, { ...i, patientId: "22" }), false);
});
