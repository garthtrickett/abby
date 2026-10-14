/** Explicit send requests only. A missing email or a delivery question is read-only. */
export function confirmationResendLanguage(text: string): "request" | "unsupportedRecipient" | undefined {
  const value = text.toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  if (/\b(?:don't|do not|never|not|stop)\b/.test(value)) return undefined;
  if (/\b(?:send|resend)\b/.test(value) && /\b(?:email|confirmation|appointment details)\b/.test(value) &&
      /@|\b(?:another|different|someone else|wife|husband|daughter|son|new address)\b/.test(value)) return "unsupportedRecipient";
  return /^(?:(?:can|could|would|will) you |(?:please |i want you to |i would like you to ))?(?:resend|send)(?: me)? (?:my|the) (?:appointment (?:confirmation(?: email)?|details(?: email)?|email)|confirmation email)(?: again)?(?: please)?$/.test(value)
    ? "request" : undefined;
}
