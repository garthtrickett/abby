/** Select an explicitly requested workflow only. Relationship words supply
 * neither patient identity nor authority; both are checked privately later. */
export function representativeRequestLanguage(text: string): "book" | "cancel" | "reschedule" | "appointments.read" | undefined {
  if (typeof text !== "string" || text.length > 4000 || /\b(?:don't|do not|not trying to|no need to)\b/i.test(text) ||
      !/\b(?:for|about|on behalf of|check)\b/i.test(text) ||
      !/\b(?:someone else|another person|my (?:daughter|son|wife|husband|partner|mother|father|child)|the patient|a patient)\b/i.test(text)) return undefined;
  if (/\bcancel\b/i.test(text)) return "cancel";
  if (/\b(?:reschedule|rearrange|move|change)\b/i.test(text) && /\bappointment\b/i.test(text)) return "reschedule";
  if (/\b(?:book|booking|make|arrange)\b/i.test(text) && /\bappointment\b/i.test(text)) return "book";
  if (/\b(?:when|time|confirm|check)\b/i.test(text) && /\bappointment\b/i.test(text)) return "appointments.read";
  return undefined;
}
