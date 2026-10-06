import { normalizedSpokenName } from "./pending-location.ts";

/** Public names only; provider IDs and private approval paths never cross this seam. */
export type BookingSearchPreference = Readonly<{ practitioner?: string | "any"; location?: string }>;
export function validBookingSearchPreference(value: unknown): value is BookingSearchPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ["practitioner", "location", "location,practitioner"].includes(Object.keys(row).sort().join(",")) &&
    (row.practitioner === undefined || !!normalizedSpokenName(row.practitioner)) && (row.location === undefined || !!normalizedSpokenName(row.location));
}
export type BookingSearchScope = Readonly<{ locationName: string; practitioners: readonly string[];
  from: string; to: string; selection: "default" | "preferred" | "earliestApproved" }>;
