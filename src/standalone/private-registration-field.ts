import { conversationControl } from "../core/conversation-control.ts";
import type { ClinikoIntakeAdditionalField } from "../cliniko/patient-intake.ts";
import { privateIntakeField } from "./private-intake-field.ts";
import { privatePatientCorrectionField } from "./private-patient-correction-field.ts";

export type RegistrationSpokenField = "firstName" | "lastName" | "dateOfBirth" | "email" | ClinikoIntakeAdditionalField;
const native = { address1: "address_1", address2: "address_2", address3: "address_3", city: "city", state: "state",
  postCode: "post_code", countryCode: "country_code" } as const;
export const registrationFieldPrompts: Readonly<Record<RegistrationSpokenField, string>> = {
  firstName: "Please say your first name.", lastName: "Please say your last name.",
  dateOfBirth: "Please say your date of birth, using the day, month name and year.", email: "Please say your email address. You may say at and dot.",
  address1: "Please say the first line of your address.", address2: "Please say the second line of your address.",
  address3: "Please say the third line of your address.", city: "Please say your town or city.",
  state: "Please say your state or county.", postCode: "Please say your postcode or postal code.",
  countryCode: "Please say your two-letter country code.",
};

/** Private deterministic parsing only; an empty/removal value cannot satisfy a required field. */
export function privateRegistrationField(field: RegistrationSpokenField, text: string, countryCallingCode: string, fragment?: string) {
  if (field === "firstName" || field === "lastName" || field === "dateOfBirth" || field === "email") return privateIntakeField(field, text, fragment);
  if (conversationControl(text)) return undefined;
  const key = native[field], decoded = privatePatientCorrectionField(key, text, countryCallingCode)?.[key];
  return typeof decoded === "string" ? { kind: "value" as const, value: decoded } : undefined;
}
