import type { FinancialEvidenceReason } from "../core/financial-evidence.ts";
/** Complete current financial requests only. No card collection, insurer
 * eligibility, payment send or receipt may be inferred from caller wording. */
export function financialEvidenceLanguage(text: string): FinancialEvidenceReason | undefined {
 const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "");
 if (/^(?:(?:the message is|please add):? )?my card number is [0-9 -]{13,37}$/.test(value) ||
     /^(?:has my (?:deposit|payment) been (?:paid|received)|can i pay (?:the|my) (?:deposit|payment) by card|do you need my card details|please (?:send|resend) (?:me )?(?:a|my|the) payment link|my (?:google pay|card|deposit) payment failed|the deposit link never arrived|the appointment was booked without a deposit)$/.test(value)) return "paymentEvidenceUnavailable";
 if (/^(?:will my refund happen automatically|can you refund my payment|has my refund been issued|will i get an automatic refund|please waive my cancellation fee|presumably you will automatically refund the payment i already made)$/.test(value)) return "refundEvidenceUnavailable";
 if (/^(?:can you confirm (?:my )?(?:axa|bupa|vitality) policy covers this appointment|is my acc claim approved|do you accept (?:axa|bupa|vitality)|is this appointment covered by my insurance|can you confirm this will be covered)$/.test(value)) return "coverageEvidenceUnavailable";
 if (/^(?:please reserve (?:that|this|the) time until i pay|please extend my payment deadline|please book (?:it|this appointment) only once my insurance is confirmed)$/.test(value)) return "reservationEvidenceUnavailable";
 return undefined;
}
