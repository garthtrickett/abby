/** Explicit send requests only. A missing email or a delivery question is read-only. */
export function confirmationResendLanguage(text: string): "request" | "anotherAppointment" | "unsupportedRecipient" | undefined {
  const value = text.toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  if (/\b(?:don't|do not|never|not|stop)\b/.test(value)) return undefined;
  if (/^(?:did|have|has|was|were|is|are)\b/.test(value)) return undefined;
  if (/^(?:(?:can|could|would|will) you |(?:please |i want you to |i would like you to ))?(?:resend|send)(?: me)? (?:my|the) (?:confirmation email|appointment details(?: email)?) for another appointment(?: please)?$/.test(value))
    return "anotherAppointment";
  if (/\b(?:send|resend)\b/.test(value) && /\b(?:email|confirmation|appointment details)\b/.test(value) &&
      /@|\b(?:another|different|someone else|wife|husband|daughter|son|new address)\b/.test(value)) return "unsupportedRecipient";
  return /^(?:(?:can|could|would|will) you |(?:please |i want you to |i would like you to ))?(?:resend|send)(?: me)? (?:my|the) (?:(?:(?:cancelled|canceled|telehealth|virtual|in-person) )?appointment (?:confirmation(?: email)?|details(?: email)?|email)|confirmation email)(?: again)?(?: please)?$/.test(value)
    ? "request" : undefined;
}
