export type ConversationControl = "pause" | "goodbye" | "resume";
export type ConversationControlNotice = ConversationControl | "pauseLimit";

/** Only complete caller controls; quoted, mixed, conditional and negated requests stay ordinary turns. */
export function conversationControl(text: string): ConversationControl | undefined {
  const value = text.trim().toLowerCase().replaceAll("’", "'").replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (/^(?:please hold|(?:please )?hold on|(?:please )?give me (?:a moment|a second|two seconds)|(?:please )?wait(?: a moment)?|(?:hold on[,;]? |(?:please )?wait )(?:while i|let me) (?:write (?:that|it) down|check my diary|check my calendar))$/.test(value)) return "pause";
  if (/^(?:(?:thank you|thanks)[,;]? )?(?:bye(?:-bye)?|goodbye)$/.test(value)) return "goodbye";
  if (/^(?:actually[,;]? i have more|(?:actually[,;]? |wait[,;]? )?(?:one more thing|i have (?:another|one more) question))$/.test(value)) return "resume";
  return undefined;
}

export const conversationControlText: Readonly<Record<ConversationControlNotice, string>> = {
  pause: "Of course. I'll wait up to thirty seconds. Let me know when you're ready.",
  pauseLimit: "Please tell me what you need when you're ready, or call the clinic back.",
  goodbye: "Goodbye. If you have one more question, please tell me now.",
  resume: "I'm here. Please tell me what else you need.",
};

export function validConversationControlNotice(value: unknown): value is ConversationControlNotice {
  return value === "pause" || value === "pauseLimit" || value === "goodbye" || value === "resume";
}
