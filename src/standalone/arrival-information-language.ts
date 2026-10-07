export type ArrivalInformationBoundary = "arrivalAccessUnavailable" | "publicFactConflict";
/** Caller reports are negative evidence against reusing routine instructions.
 * They establish no current access, staff presence, address or opening hours. */
export function arrivalInformationLanguage(text: string): ArrivalInformationBoundary | undefined {
 const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "");
 if (!value || value.length > 350 || /[\n\r"“”]/.test(value)) return undefined;
 if (/^(?:i have|i've|i) arrived for my appointment (?:but the door is locked|and nobody is here)$/.test(value) ||
  /^(?:the intercom is inaccessible because of roadworks|there is no intercom i can use|the gate is being dug up and i cannot get inside|the entrance step is not accessible to my wheelchair|can you open the door for me)$/.test(value)) return "arrivalAccessUnavailable";
 if (/^(?:your website and confirmation email give different addresses|you gave me conflicting opening hours|the clinic address you gave me is wrong)$/.test(value)) return "publicFactConflict";
 return undefined;
}
