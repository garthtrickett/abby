import { validBookingPractitionerPreference } from "../core/booking-practitioner-preference.ts";
import type { BookingPractitionerPreference, PractitionerGender } from "../core/booking-practitioner-preference.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";

type Member = Readonly<{ practitionerId: string; name: string; gender?: PractitionerGender }>;
/** Filter only declared clinic metadata. Unknown metadata is never guessed. */
export function eligibleServicePractitioners<T extends Member>(members: readonly T[], preference?: BookingPractitionerPreference): readonly T[] {
  if (preference === undefined) return members;
  if (!validBookingPractitionerPreference(preference)) return [];
  if (preference.kind === "any") return members;
  if (preference.kind === "gender") return members.filter(member => member.gender === preference.gender);
  return members.filter(member => normalizedSpokenName(member.name) === normalizedSpokenName(preference.name));
}

/** Context-free changes need an explicit request prefix; short answers are
 * permitted only by the dialogue's played-question binding. */
export function servicePractitionerPreferenceLanguage(text: string, answering = false): BookingPractitionerPreference | undefined {
  const raw = text.trim().replace(/[.!?]+$/, "").replace(/,? please$/i, "");
  if (!raw || raw.length > 150 || /[\r\n"“”]/.test(raw)) return undefined;
  const request = raw.match(/^(?:I would prefer|I prefer|I'd prefer|Can I see|Could I see|Please book me with) (.+)$/i);
  if (!request && !answering) return undefined;
  const value = (request?.[1] ?? raw).replace(/^(?:a|an) /i, "");
  if (/^(?:any|anyone|any practitioner|no preference|no)$/.test(value.toLowerCase())) return { kind: "any" };
  const gender = value.match(/^(female|male|non-binary|nonbinary)(?: (?:physiotherapist|therapist|practitioner))?$/i);
  if (gender) return { kind: "gender", gender: gender[1]!.toLowerCase().startsWith("non") ? "nonBinary" : gender[1]!.toLowerCase() as PractitionerGender };
  return normalizedSpokenName(value) && normalizedSpokenName(value) !== "any" ? { kind: "name", name: value } : undefined;
}
