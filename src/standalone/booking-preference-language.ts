import type { BookingSearchPreference } from "../core/booking-search-preference.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";

/** Public preference syntax; never a provider ID, implicit fallback consent or
 * clinical service selection. Unmatched names are checked by the call owner. */
export function bookingPreferenceLanguage(text: string): BookingSearchPreference | Readonly<{ kind: "originalPractitioner" }> | undefined {
  const value = text.trim().replace(/[.!?]+$/, "").replace(/\s+/g, " ");
  if (/^(?:(?:can|could) (?:I|we) |(?:please )?)?(?:go back to|check|see) (?:my|the) original practitioner(?: again)?(?:,? please)?$/i.test(value))
    return { kind: "originalPractitioner" };
  if (/^(?:anyone|any practitioner) is fine(?:[.!?]? (?:what is|what's) the soonest opening)?$/i.test(value)) return { practitioner: "any" };
  const person = value.match(/^(?:I would rather see|I prefer|I want to see|Can I see) (.+?)(?:,? even if I have to wait|,? please)?$/i);
  if (person && normalizedSpokenName(person[1])) return { practitioner: person[1]! };
  const location = value.match(/^(?:I need|I want|Can I use) (?:the other branch,? |the |the clinic at )?(.+)$/i);
  if (location && /\b(?:branch|location|clinic)\b/i.test(value) && normalizedSpokenName(location[1])) return { location: location[1]! };
  return undefined;
}
