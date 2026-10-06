import type { StaffRequestSubject } from "../core/staff-request-subject.ts";

/** Whole current requests only. Public category, never an amount, recipient,
 * diagnosis, appointment ref, refund authorization or waitlist enrollment. */
export function staffRequestSubjectLanguage(text: string): StaffRequestSubject | undefined {
  const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "");
  if (/^(?:(?:could|can|would) (?:you|the clinic)|please) (?:send|resend|email|forward)(?: me)? (?:my |a |the )?(?:paid receipt|invoice)(?: (?:copy|again|please))?$/.test(value) ||
      /^(?:i (?:want|need|would like)|could i (?:get|have)) (?:a |my |the )?(?:copy of (?:my |the )?)?(?:paid receipt|invoice)$/.test(value)) return "invoiceCopy";
  if (/^(?:i arrived on the day i was told[.!?]\s*)?(?:could|can|would) (?:someone|somebody|the clinic|you) (?:review|check|look into) (?:the |my |that )?(?:charge|payment|refund)(?: before i arrange another visit| please)?$/.test(value) ||
      /^please (?:ask|have) (?:someone|the clinic|staff) (?:to )?(?:review|check) (?:the |my )?(?:charge|payment|refund)$/.test(value)) return "chargeReview";
  if (/^(?:if a (?:slot|time|appointment) opens (?:sooner|earlier),? )?(?:could|can|would) you (?:put|add) me (?:on|to) (?:a|the|your) (?:list|waitlist|waiting list)(?: and call me)?$/.test(value) ||
      /^please (?:put|add) me (?:on|to) (?:a|the|your) (?:waitlist|waiting list)$/.test(value)) return "waitlistInterest";
  return undefined;
}
