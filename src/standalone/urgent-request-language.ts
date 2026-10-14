/** Explicit urgency or inability to breathe is a routing cue, never a diagnosis.
 * Negated urgency and quoted/background language remain classifier decisions. */
export function explicitUrgentRequest(text: string): boolean {
  const value = text.toLowerCase().replace(/[’]/g, "'");
  if (/\b(?:cannot|can't|can not|unable to) breathe\b/.test(value) &&
      !/\b(?:background|television|tv|radio|programme|program|quoting)\b/.test(value)) return true;
  if (/\b(?:not (?:an? )?(?:urgent|emergency)|(?:do not|don't) (?:need|want|require) (?:an? )?(?:urgent|emergency)|no (?:need for )?(?:urgent|emergency))\b/.test(value) ||
      /\b(?:background|television|tv|radio|programme|program|quoting)\b/.test(value)) return false;
  return /\b(?:urgent (?:medical (?:help|attention)|help)|medical emergency|emergency medical (?:help|attention))\b/.test(value);
}
