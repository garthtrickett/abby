import { validBookingPractitionerPreference } from "./booking-practitioner-preference.ts";
import type { BookingPractitionerPreference } from "./booking-practitioner-preference.ts";
import { normalizedSpokenName } from "./pending-location.ts";

/** Caller-requested public service attributes and clinic-approved self-report
 * answers. Neither provider identifiers nor private approval paths belong here. */
export type BookingServiceChoice = Readonly<{ name: string; durationMinutes: number; visitKind: "initial" | "followUp";
  returningPatient?: boolean; newProblem?: boolean; monthsSinceLastVisit?: number; practitionerPreference?: BookingPractitionerPreference }>;
export function validBookingServiceChoice(value: unknown): value is BookingServiceChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ["name", "durationMinutes", "visitKind", "returningPatient", "newProblem", "monthsSinceLastVisit", "practitionerPreference"].includes(key)) &&
    !!normalizedSpokenName(row.name) && Number.isSafeInteger(row.durationMinutes) && Number(row.durationMinutes) >= 1 && Number(row.durationMinutes) <= 480 &&
    typeof row.visitKind === "string" && ["initial", "followUp"].includes(row.visitKind) && (row.returningPatient === undefined || typeof row.returningPatient === "boolean") &&
    (row.newProblem === undefined || typeof row.newProblem === "boolean") &&
    (row.practitionerPreference === undefined || validBookingPractitionerPreference(row.practitionerPreference)) &&
    (row.monthsSinceLastVisit === undefined || Number.isSafeInteger(row.monthsSinceLastVisit) && Number(row.monthsSinceLastVisit) >= 0 && Number(row.monthsSinceLastVisit) <= 2400);
}

export function copyBookingServiceChoice(value: unknown): BookingServiceChoice | undefined {
  if (!validBookingServiceChoice(value)) return undefined;
  return Object.freeze({ ...value, ...(value.practitionerPreference ? { practitionerPreference: Object.freeze({ ...value.practitionerPreference }) } : {}) });
}
