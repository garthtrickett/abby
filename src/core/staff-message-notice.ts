export const staffMessageNotices = ["collecting", "updated", "discarded", "tooLong", "notReady", "alreadySent"] as const;
export type StaffMessageNotice = typeof staffMessageNotices[number];
export const validStaffMessageNotice = (value: unknown): value is StaffMessageNotice => staffMessageNotices.includes(value as StaffMessageNotice);
export const staffMessageNoticeText: Record<StaffMessageNotice, string> = {
  collecting: "Please tell me the message. You can add details or replace it before asking me to send it. Nothing has been sent yet.",
  updated: "I've kept those message details for this call. Nothing has been sent yet. You can add details, replace the message, discard it, or ask me to send it.",
  discarded: "The message was discarded and not sent.",
  tooLong: "I couldn't include those details because the message is too long or contains unsupported characters. Please give a shorter message or replace it. Nothing has been sent yet.",
  notReady: "Your message has not been sent. Please tell me the message, then ask me to send it after I've finished speaking.",
  alreadySent: "I can't append those details to the earlier request, and I won't send another request from this call. Please contact the clinic directly.",
};
