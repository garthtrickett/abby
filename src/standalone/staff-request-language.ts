import type { VoiceIntent } from "../voice/voice-session.ts";

/** Public, bounded request language. A name is only a preference; the trusted
 * queue approval resolves it before any patient lookup, verification or send. */
export function staffRequestLanguage(text: string): VoiceIntent | undefined {
  const value = text.trim().replace(/[.!?]+$/, "");
  if (/^(?:has|have|did|was|is|were|can you (?:confirm|check)|do you know)\b/i.test(value) &&
      /\b(?:message|staff request|callback request|my request)\b/i.test(value)) return { kind: "staffOutcome" };
  if (/\b(?:do not|don't|never|no need to)\b/i.test(value)) return undefined;
  const speak = value.match(/^(?:(?:please|actually),?\s*)?(?:(?:can|could|may) I|I (?:want|need|would like) to|let me) (?:speak|talk) (?:to|with) (.+?)(?: rather than .*)?$/i);
  const call = value.match(/^(?:please )?(?:ask|have) (.+?) (?:to )?call me(?: back)?(?: about (?:this|that))?$/i);
  const message = value.match(/^(?:(?:please|can you|could you) )?(?:send|pass|leave)(?: that| the| a| my)? (?:staff )?(?:message|request)(?: (?:to|for) (.+))?$/i);
  const preference = (speak?.[1] ?? call?.[1] ?? message?.[1])?.replace(/,? please$/i, "");
  if (!speak && !call && !message) return undefined;
  if (!preference || /^(?:a |the )?(?:receptionist|reception|staff|staff member|team|person|human|human being|someone|somebody|anyone)$/i.test(preference)) return { kind: "staffRequest" };
  return { kind: "staffRequest", requestedPerson: preference };
}
