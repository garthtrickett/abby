import type { VoiceIntent } from "../voice/voice-session.ts";
import type { PublicInformationTopic } from "../core/public-information.ts";

/** Complete public questions only; no symptom-to-service selection or inferred
 * patient/appointment target. Paraphrases still use structured classification. */
export function publicInformationLanguage(text: string): PublicInformationTopic | undefined {
  const value = text.trim().toLowerCase().replace(/[’]/g, "'");
  if (/^(?:i (?:do not|don't) know|i am (?:not sure|unsure)|i'm (?:not sure|unsure)) (?:which|what) (?:appointment type|service)(?: i (?:need|should (?:book|choose)))?[.!?]*$/.test(value) ||
      /^(?:what|which) (?:appointment types|services) (?:do you (?:offer|have)|are available)[.!?]*$/.test(value)) return "serviceGuidance";
  if (/^what would this visit cost,? and would i pay a fee to cancel[.!?]*$/.test(value) ||
      /^(?:how much (?:does|would) (?:this|the) (?:visit|appointment) cost|what (?:is|are) (?:the |your )?(?:price|prices|cancellation fee|cancellation fees))[.!?]*$/.test(value)) return "priceAndFees";
  return undefined;
}

/** Public clinic facts cannot clear a patient to attend after treatment. This
 * bounded language guard supplies no diagnosis, urgency assessment or permission. */
export function clinicalAdviceBoundary(text: string): VoiceIntent | undefined {
  const value = text.toLowerCase().replace(/[’]/g, "'");
  if (/\b(?:is it safe(?: for me)?|can i safely|should i (?:attend|come|visit))\b/.test(value) &&
      /\b(?:treatment|procedure|operation|surgery|medical|symptoms?)\b/.test(value))
    return { kind: "clarify", reason: "clinicalAdviceUnavailable" };
  return undefined;
}
