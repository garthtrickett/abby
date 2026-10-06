export const staffRequestSubjects = ["invoiceCopy", "chargeReview", "waitlistInterest"] as const;
export type StaffRequestSubject = typeof staffRequestSubjects[number];
export const validStaffRequestSubject = (value: unknown): value is StaffRequestSubject => staffRequestSubjects.includes(value as StaffRequestSubject);
export const staffRequestSubjectLabel: Record<StaffRequestSubject, string> = {
  invoiceCopy: "an invoice or paid receipt copy", chargeReview: "reviewing a charge", waitlistInterest: "earlier appointments and the clinic's waitlist process",
};
export const staffRequestSubjectLimit: Record<StaffRequestSubject, string> = {
  invoiceCopy: "The clinic needs to arrange delivery of the billing document.",
  chargeReview: "Any refund, fee waiver or appointment-record correction needs a clinic decision. I haven't booked another visit for this request.",
  waitlistInterest: "Waitlist enrollment and any callback need separate confirmation from the clinic.",
};
export function staffSubjectUnavailable(subject: StaffRequestSubject): string {
  return subject === "invoiceCopy" ? "I can't read or email a billing document or save this staff request from this call. Please contact the clinic for an invoice or paid receipt copy."
    : subject === "chargeReview" ? "I can't save this request to review a charge or issue a refund from this call. Please contact the clinic to review the charge. I haven't booked another visit for this request."
    : "I can't save this request, enroll you on a waitlist or promise a callback from this call. Please contact the clinic about earlier appointments and its waitlist process.";
}
