/** A presence reply makes no result, availability or appointment claim. */
export const conversationPresenceText = "I'm here. I don't have new confirmed options for this request. Please tell me what you'd like me to check, or contact the clinic directly.";

export function isPresenceQuestion(text: string): boolean {
  const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "");
  return /^(?:are you (?:still )?there|can you (?:still )?hear me|hello)$/.test(value);
}
