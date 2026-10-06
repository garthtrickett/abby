import type { CallerIdentityDenial } from "../core/caller-identity.ts";

/** Explicit first-person denial only; quoted/background/negated phone descriptions do not revoke a grant. */
export function callerIdentityLanguage(text: string): CallerIdentityDenial | undefined {
  const value = text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  if (/^(?:(?:no|sorry|actually)[,. ]+)?(?:that (?:isn't|is not|wasn't|was not) me|that's not me|you have (?:the )?wrong person|i(?:'m| am) not that patient)(?:[.!?,]|$)/.test(value))
    return "identityDisagreement";
  if (/^(?:(?:sorry|actually)[,. ]+)?(?:this is (?:a|our) shared (?:phone|number)|we share (?:this|the) (?:phone|number)|i share (?:this|the) (?:phone|number)|my (?:partner|spouse|family) and i (?:both )?use (?:this (?:phone|number)|the number i am ringing from))(?:[.!?,]|$)/.test(value))
    return "sharedPhone";
  return undefined;
}
