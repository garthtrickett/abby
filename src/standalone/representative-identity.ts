import { clinicDateAt } from "./clinic-clock.ts";

export type RepresentativeIdentity = Readonly<{ firstName: string; lastName: string; dateOfBirth: string }>;

/** Private selection fields only; never a clinic authority or patient proof. */
export function validRepresentativeIdentity(value: unknown): value is RepresentativeIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const label = (item: unknown, maximum: number): item is string => typeof item === "string" && item === item.trim() &&
    item.length > 0 && item.length <= maximum && !/[\p{Cc}\p{Cf}]/u.test(item);
  return Object.keys(row).sort().join(",") === "dateOfBirth,firstName,lastName" && label(row.firstName, 50) && label(row.lastName, 255) &&
    typeof row.dateOfBirth === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.dateOfBirth) && Number.isFinite(Date.parse(row.dateOfBirth)) &&
    new Date(row.dateOfBirth).toISOString().slice(0, 10) === row.dateOfBirth;
}

export function representativeSubjectEligible(dateOfBirth: string,
  authority: Readonly<{ authorityKind: "guardian" | "adultRepresentative"; subjectKind: "minor" | "adult" }>,
  policy: Readonly<{ timeZone: string; adultAgeYears: number }>, now: string): boolean {
  const today = clinicDateAt(policy.timeZone, new Date(now));
  if (dateOfBirth > today) return false;
  // Feb 29 birthdays reach the boundary on March 1 in non-leap years.
  const age = Number(today.slice(0, 4)) - Number(dateOfBirth.slice(0, 4)) - (today.slice(5) < dateOfBirth.slice(5) ? 1 : 0);
  return age >= policy.adultAgeYears ? authority.subjectKind === "adult" && authority.authorityKind === "adultRepresentative"
    : authority.subjectKind === "minor" && authority.authorityKind === "guardian";
}
