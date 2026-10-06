import type { VoiceIntent } from "../voice/voice-session.ts";

/** Public clinic facts cannot clear a patient to attend after treatment. This
 * bounded language guard supplies no diagnosis, urgency assessment or permission. */
export function clinicalAdviceBoundary(text: string): VoiceIntent | undefined {
  const value = text.toLowerCase().replace(/[’]/g, "'");
  if (/\b(?:is it safe(?: for me)?|can i safely|should i (?:attend|come|visit))\b/.test(value) &&
      /\b(?:treatment|procedure|operation|surgery|medical|symptoms?)\b/.test(value))
    return { kind: "clarify", reason: "clinicalAdviceUnavailable" };
  return undefined;
}
