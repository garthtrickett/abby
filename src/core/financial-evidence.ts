import { confirmedActionText } from "./action-outcome.ts";
import { classMovementOutcomeText } from "./class-movement-continuation.ts";
import type { ActionState } from "./model.ts";
export const financialEvidenceReasons = ["paymentEvidenceUnavailable", "coverageEvidenceUnavailable", "refundEvidenceUnavailable", "reservationEvidenceUnavailable"] as const;
export type FinancialEvidenceReason = typeof financialEvidenceReasons[number];
export function isFinancialEvidenceReason(value: unknown): value is FinancialEvidenceReason {
 return typeof value === "string" && (financialEvidenceReasons as readonly string[]).includes(value);
}
const notices: Record<FinancialEvidenceReason, string> = {
 paymentEvidenceUnavailable: "I can't verify a payment or deposit, take card details, or send or resend a payment link on this call. Please contact the clinic to check payment or arrange a secure link.",
 coverageEvidenceUnavailable: "I can't verify insurer recognition, your policy coverage or claim approval on this call. Recognition by an insurer does not confirm your individual cover. Please check with your insurer and the clinic before relying on coverage.",
 refundEvidenceUnavailable: "I can't approve a refund, confirm it is automatic, waive a fee or verify a refund has been issued. The clinic must check payment and its applicable terms. Please contact the clinic to review the refund or charge.",
 reservationEvidenceUnavailable: "I can't hold an appointment until payment, confirm a paid booking or extend a payment deadline here. Please contact the clinic to arrange a payment-dependent reservation. I haven't reserved another time or sent a payment link for this request.",
};
/** An appointment receipt is independent of payment, insurance and refunds. */
export function financialEvidenceText(reason: FinancialEvidenceReason, latest?: Pick<ActionState, "kind" | "status" | "classMovement">): string {
 const prefix = latest?.classMovement ? classMovementOutcomeText(latest.classMovement)
  : latest?.status === "committed" ? confirmedActionText(latest.kind) : latest && ["uncertain", "needsReview", "dispatched"].includes(latest.status)
  ? "I can't confirm that action yet. It is pending review. Please contact the clinic before trying again. I won't send that action again from this call." : undefined;
 return `${prefix ? `${prefix} ` : ""}${notices[reason]}`;
}
