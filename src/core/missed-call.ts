/** No outbound-call reason authority exists in the standalone call contract. */
export const missedCallText = "I don't know why the clinic called you. I can't verify an outbound-call reason from this call. Please contact the clinic directly.";

/** Whole current caller questions only; reported, quoted and negated context
 * does not become a reason query or permission for patient access. */
export function isMissedCallQuestion(text: string): boolean {
  const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:i missed a call from this number|i missed your call|i(?: am|'m) returning a missed call|you called me) (?:what was (?:it|that) about|why did (?:you|the clinic) call me)$/.test(value) ||
    /^(?:why did (?:you|the clinic) (?:call|ring) me|what was (?:your|the clinic's) (?:missed )?call (?:about|for))$/.test(value);
}
