import { sign } from "node:crypto";
import { financialResendFixture } from "./financial-resend-owner.ts";
import { intentValue, keys, keyRef, now, uuid } from "./financial-retention.ts";
import { financialBookingObservationPayload, financialBookingObservationMessage, formatFinancialBookingObservation,
  financialIntentDigest } from "../../src/cliniko/financial-booking-observation.ts";
import type { ClinikoFinancialIntent } from "../../src/cliniko/financial-review-intent.ts";
import type { FinancialRecordRetentionConfig } from "../../src/cliniko/financial-record-retention.ts";
import type { FinancialEffectBarrier } from "../../src/standalone/financial-effect-barrier.ts";
import type { FinancialMessagePurpose } from "../../src/cliniko/financial-message-attempt.ts";

/** Signed original class-creation context only. A requested case is historical
 * context, never current entitlement, payment or permission for a class write. */
export async function financialClassResendFixture(options: { patientCaseId?: string; purpose?: FinancialMessagePurpose;
  intent?: ClinikoFinancialIntent; barrierFactory?: (config: FinancialRecordRetentionConfig) => FinancialEffectBarrier } = {}) {
  const source = options.intent ?? intentValue(), intent: ClinikoFinancialIntent = {
    ...source, booking: { ...source.booking, kind: "classBook", sessionId: "91" },
  };
  return financialResendFixture({ ...(options.purpose ? { purpose: options.purpose } : {}), message: { checkout: { native: { intent,
    ...(options.barrierFactory ? { barrierFactory: options.barrierFactory } : {}) }, bookingObservation: i => {
    const proof = { actionRef: uuid(8), financialActionRef: i.actionRef, intentRecallRef: "cliniko:recall:30", intentDigest: financialIntentDigest(i)!,
      bookingActionRef: i.booking.actionRef, targetRef: "cliniko:attendee:91", observedAt: now, producerKeyRef: keyRef,
      financialConsent: { presentationRef: uuid(40), presentationDigest: "a".repeat(64), playedAt: now, acceptedAt: now, acceptanceRef: uuid(41) },
      classCreationRequest: { sessionId: "91", ...(options.patientCaseId ? { patientCaseId: options.patientCaseId } : {}) } };
    const payload = financialBookingObservationPayload(proof); if (!payload) throw new Error("Synthetic class citation unavailable");
    const notes = formatFinancialBookingObservation(proof, sign(null, financialBookingObservationMessage(payload, 3), keys.privateKey).toString("base64url"));
    if (!notes) throw new Error("Synthetic class citation unavailable"); return notes;
  } } } });
}
