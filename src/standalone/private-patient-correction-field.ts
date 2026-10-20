import { normalizePatientPhone } from "../cliniko/phone-number.ts";
import type { PatientDetailChanges, PatientDetailField, PatientPhone } from "../cliniko/patient-details.ts";
import { validPatientDetailChanges } from "../cliniko/patient-details.ts";
import { privateIntakeField } from "./private-intake-field.ts";

/** Deterministic private field decoder. No identity, permission or model inference. */
export function privatePatientCorrectionField(field: PatientDetailField, text: string, countryCallingCode: string): PatientDetailChanges | undefined {
  if (typeof text !== "string" || text.length > 2000 || /[\p{Cc}\p{Cf}]/u.test(text)) return undefined;
  const value = text.trim().replace(/[.!?]$/, "").trim();
  if (/^(?:yes|no|okay|thanks|thank you|hold|wait|hold on)$/i.test(value)) return undefined;
  let decoded: unknown;
  if (["first_name", "last_name", "date_of_birth", "email"].includes(field)) {
    const parsed = privateIntakeField(({ first_name: "firstName", last_name: "lastName", date_of_birth: "dateOfBirth", email: "email" } as const)[field as "first_name" | "last_name" | "date_of_birth" | "email"], value);
    decoded = parsed?.kind === "value" ? parsed.value : undefined;
  } else if (field === "patient_phone_numbers") {
    if (/^clear all phone numbers$/i.test(value)) decoded = [];
    else {
      const parts = value.replace(/\bsemicolon\b/gi, ";").split(/\s*;\s*/);
      const phones: PatientPhone[] = [];
      for (const part of parts) {
        const match = /^(mobile|home|work|other|fax)\s*[:,]?\s*(\+?[0-9][0-9 ()-]+)$/i.exec(part);
        if (!match) return undefined;
        const number = normalizePatientPhone(match[2]!, countryCallingCode);
        if (!number) return undefined;
        phones.push({ number, phone_type: (match[1]![0]!.toUpperCase() + match[1]!.slice(1).toLowerCase()) as PatientPhone["phone_type"] });
      }
      decoded = phones;
    }
  } else if (/^remove this value$/i.test(value)) decoded = null;
  else decoded = field === "country_code" ? value.replace(/[ ,.-]/g, "").toUpperCase() : value;
  const changes = { [field]: decoded };
  return validPatientDetailChanges(changes) ? changes : undefined;
}
