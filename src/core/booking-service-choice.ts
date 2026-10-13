import { normalizedSpokenName } from "./pending-location.ts";

/** Caller-requested public service attributes and clinic-approved self-report
 * answers. Neither provider identifiers nor private approval paths belong here. */
export type BookingServiceChoice = Readonly<{ name: string; durationMinutes: number; visitKind: "initial" | "followUp";
  returningPatient?: boolean; newProblem?: boolean; monthsSinceLastVisit?: number }>;
export function validBookingServiceChoice(value: unknown): value is BookingServiceChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ["name", "durationMinutes", "visitKind", "returningPatient", "newProblem", "monthsSinceLastVisit"].includes(key)) &&
    !!normalizedSpokenName(row.name) && Number.isSafeInteger(row.durationMinutes) && Number(row.durationMinutes) >= 1 && Number(row.durationMinutes) <= 480 &&
    typeof row.visitKind === "string" && ["initial", "followUp"].includes(row.visitKind) && (row.returningPatient === undefined || typeof row.returningPatient === "boolean") &&
    (row.newProblem === undefined || typeof row.newProblem === "boolean") &&
    (row.monthsSinceLastVisit === undefined || Number.isSafeInteger(row.monthsSinceLastVisit) && Number(row.monthsSinceLastVisit) >= 0 && Number(row.monthsSinceLastVisit) <= 2400);
}
