import type { CallerIdentityDenial } from "../core/caller-identity.ts";

/** Explicit caller/patient changes and phone ownership declarations only.
 * Quoted/background and negated phone descriptions do not revoke a grant. */
export function callerIdentityLanguage(text: string): CallerIdentityDenial | undefined {
  const value = text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  if (/^(?:(?:no|sorry|actually)[,. ]+)?(?:that (?:isn't|is not|wasn't|was not) me|that's not me|you have (?:the )?wrong person|i(?:'m| am) not that patient)(?:[.!?,]|$)/.test(value))
    return "identityDisagreement";
  if (/^(?:(?:sorry|actually)[,. ]+)?(?:this is (?:a|our) shared (?:phone|number)|we share (?:this|the) (?:phone|number)|i share (?:this|the) (?:phone|number)|my (?:partner|spouse|family) and i (?:both )?use (?:this (?:phone|number)|the number i am ringing from))(?:[.!?,]|$)/.test(value))
    return "sharedPhone";
  const prefix = "(?:(?:no|sorry|actually)[,. ]+)?";
  const name = "[\\p{L}][\\p{L}\\p{M} '-]{0,79}";
  const changed = [
    `my name is ${name},? not ${name}`,
    `(?:her|his|their) name is ${name}`,
    "(?:the )?patient is someone else",
    "(?:the )?(?:booking|appointment) is for my (?:wife|husband|partner|mother|father|child|friend)",
    `(?:it's|it is) for ${name},? not me`,
    "i(?:'m| am) booking for my (?:wife|husband|partner|mother|father|child|friend),? not (?:me|myself)",
    "i(?:'m| am) (?:her|his|their) (?:boyfriend|girlfriend|husband|wife|partner|parent|mother|father)(?:,? (?:calling|booking) for (?:her|him|them))?",
  ];
  if (new RegExp(`^${prefix}(?:${changed.join("|")})[.!?]?$`, "u").test(value)) return "identityDisagreement";
  if (new RegExp(`^${prefix}(?:this (?:phone|number) belongs to my (?:wife|husband|partner|mother|father|child|friend)|we both have appointments on this number|i(?:'m| am) calling from my (?:wife|husband|partner|mother|father|child|friend)'s phone)[.!?]?$`).test(value)) return "sharedPhone";
  return undefined;
}
