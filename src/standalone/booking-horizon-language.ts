/** Bounded routing only. Vague future dates are not converted to guessed dates. */
export function bookingHorizonLanguage(text: string): boolean {
  const value = text.toLowerCase().replace(/[’]/g, "'").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:can we|could we|can you|could you|please|i (?:want|need|would like) to) (?:book|move|reschedule) (?:it|my appointment|an appointment|a visit) (?:several|a few|many) months (?:from now|ahead|away)$/.test(value) ||
    /^(?:how far (?:ahead|in advance) can (?:i|we) (?:book|move|reschedule)(?: (?:an appointment|my appointment))?|what (?:is|are) (?:the|your) (?:booking horizon|advance booking limits|appointment search limits))$/.test(value);
}
