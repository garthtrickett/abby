import type { MenuClarificationReason } from "../core/model.ts";
/** Negative boundaries only: no inferred gender, alias, history, ranking,
 * treatment style, service choice or alternate duration. Exact public names
 * remain subject to the independent approved catalogue and native cohort. */
export function serviceConstraintLanguage(text: string): MenuClarificationReason | undefined {
 const value = text.trim().toLowerCase().replace(/[’]/g, "'").replace(/[.!?]+$/, "");
 if (!value || value.length > 350 || /[\n\r"“”]/.test(value)) return undefined;
 if (/^(?:(?:i would prefer|i prefer|i'd prefer|can i see) a (?:female|male) (?:physiotherapist|therapist|practitioner)|a (?:female|male) (?:physiotherapist|therapist|practitioner),? please)$/.test(value) ||
  /^(?:who did i see last time|please book me with the practitioner i saw last time|who is the best therapist|book me with the practitioner who has the same approach as my old osteopath)$/.test(value)) return "searchPreferenceUnavailable";
 if (/^(?:i want a \d{1,3}-minute appointment|can i have a \d{1,3}-minute appointment instead|please change the appointment duration to one hour|i want a different appointment type)$/.test(value)) return "changeUnsupported";
 if (/^(?:can you recommend the best practitioner for my injury|i need treatment for both foot pain and a corn)$/.test(value)) return "clinicalAdviceUnavailable";
 return undefined;
}
