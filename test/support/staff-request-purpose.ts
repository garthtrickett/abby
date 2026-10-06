import type { StaffRequestSubject } from "../../src/core/staff-request-subject.ts";
export const staffPurposeQuestions: Record<StaffRequestSubject, string> = {
  invoiceCopy: "Could the clinic send my paid receipt again?",
  chargeReview: "I arrived on the day I was told. Could someone review the charge before I arrange another visit?",
  waitlistInterest: "If a slot opens sooner, could you put me on a list and call me?",
};
