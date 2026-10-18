import { writeFile } from "node:fs/promises";
import { financialSourceApprovalFixture } from "./financial-source-approval.ts";
import { OwnerFileFinancialFeePolicy } from "../../src/standalone/owner-file-financial-fee-policy.ts";
import type { FinancialFeeApproval } from "../../src/standalone/owner-file-financial-fee-policy.ts";
import type { FinancialBookingSelection } from "../../src/standalone/cliniko-financial-booking-preparation.ts";
const signal = () => new AbortController().signal;
export async function financialFeePolicyFixture() {
  const f = await financialSourceApprovalFixture();
  const approval: FinancialFeeApproval = { ...f.approval, selection: { policyVersion: "voice-v1", businessId: "11", credentialFingerprint: "a".repeat(64),
    practitionerId: "31", appointmentTypeId: "41", timeZone: "Australia/Sydney", bookingKind: "book", passUse: "none" },
    terms: { kind: "required", amount: 5000, currency: "aud", policyVersion: "fees-v1", termsVersion: "terms-v1",
      approvedTerms: "A deposit is required. Please pay using the secure link.", paymentWindowMinutes: 60, reviewDatePolicy: "paymentDeadlineClinicDate" } };
  delete (approval as unknown as Record<string, unknown>).source;
  const selection: FinancialBookingSelection = { scope: approval.scope, ...approval.selection, callId: "call-1", sessionId: "session-1",
    verificationRef: "verification-1", offerRef: "offer-1", patientId: "21", startsAt: "2026-11-03T00:00:00.000Z", endsAt: "2026-11-03T00:30:00.000Z",
    expiresAt: "2026-11-02T00:05:00.000Z", clinicalDigest: "b".repeat(64) };
  const replace = (patch: Record<string, unknown>) => writeFile(f.path, JSON.stringify({ ...approval, ...patch }));
  await replace({});
  return { ...f, approval, selection, replace, capture: () => OwnerFileFinancialFeePolicy.capture(f.config, signal()) };
}
