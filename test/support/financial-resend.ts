import type { FinancialResendAttempt } from "../../src/cliniko/financial-resend-attempt.ts";
import { financialResendRequestDigest } from "../../src/cliniko/financial-resend-request.ts";
import { financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { FinancialResendRequest } from "../../src/cliniko/financial-resend-request.ts";
import { financialMessageSelectionDigest } from "../../src/standalone/smtp-financial-message-delivery.ts";
import { intentValue, uuid, now } from "./financial-retention.ts";
export const resendSelection = { sender: "clinic@example.test", template: "clinicFinancial.v1" as const, timeZone: "Australia/Sydney" };
export function resendRequestValue(intent: ClinikoFinancialIntent = intentValue(), patch: Partial<FinancialResendRequest> = {}): FinancialResendRequest {
  return { actionRef: uuid(100), effectRef: uuid(101), approvalRef: uuid(102), financialActionRef: intent.actionRef,
    purpose: "linkDelivery", intentRecallRef: "cliniko:recall:30", intentDigest: financialIntentDigest(intent)!,
    observationRecallRef: "cliniko:recall:31", observationActionRef: uuid(8), targetRef: "cliniko:appointment:91",
    checkoutAttemptRecallRef: "cliniko:recall:32", checkoutAttemptActionRef: uuid(9), checkoutRef: "cs_test_owner",
    selectionDigest: financialMessageSelectionDigest(resendSelection)!, requestedAt: now, expiresAt: "2026-11-01T10:30:00.000Z", ...patch };
}

export function resendAttemptValue(request = resendRequestValue(), requestRecallRef = "cliniko:recall:33", patch: Partial<FinancialResendAttempt> = {}): FinancialResendAttempt {
  return { actionRef: uuid(200), financialActionRef: request.financialActionRef, effectRef: request.effectRef, approvalRef: request.approvalRef,
    requestRecallRef, requestActionRef: request.actionRef, requestDigest: financialResendRequestDigest(request)!, purpose: request.purpose,
    intentRecallRef: request.intentRecallRef, intentDigest: request.intentDigest, observationRecallRef: request.observationRecallRef,
    observationActionRef: request.observationActionRef, targetRef: request.targetRef, checkoutRef: request.checkoutRef,
    payloadDigest: "a".repeat(64), attemptedAt: now, ...patch };
}
