import { normalizedSpokenName } from "./pending-location.ts";

export type PractitionerGender = "female" | "male" | "nonBinary";
export type BookingPractitionerPreference = Readonly<{ kind: "any" }> | Readonly<{ kind: "name"; name: string }> |
  Readonly<{ kind: "gender"; gender: PractitionerGender }>;
export function validPractitionerGender(value: unknown): value is PractitionerGender {
  return value === "female" || value === "male" || value === "nonBinary";
}
export function validBookingPractitionerPreference(value: unknown): value is BookingPractitionerPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>, keys = Object.keys(row).sort().join(",");
  return row.kind === "any" && keys === "kind" || row.kind === "name" && keys === "kind,name" && !!normalizedSpokenName(row.name) &&
    normalizedSpokenName(row.name) !== "any" || row.kind === "gender" && keys === "gender,kind" && validPractitionerGender(row.gender);
}
