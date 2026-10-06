/** Confirmation is a narrow caller utterance, never a model interpretation. */
export function clearAffirmation(text: string): boolean {
  return /^(yes|yes, book it|yes book it|yes, please|yes please)[.!]?$/i.test(text.trim());
}
