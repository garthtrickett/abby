import { err, ok } from "./model.ts";
import type { AvailabilitySnapshot, LocationScope, Result } from "./model.ts";

export type AvailabilityPresentation = Readonly<{
  text: string;
  status: "shown" | "empty";
  sourceRef: string;
  timeZone: string;
  observedAt: string;
  shownStartsAt: readonly string[];
}>;

type InvalidEvidence = Readonly<{ kind: "invalidEvidence" }>;

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function localDate(value: Date, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(value);
  const year = parts.find(part => part.type === "year")?.value;
  const month = parts.find(part => part.type === "month")?.value;
  const day = parts.find(part => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function spokenName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120 &&
    value.trim() === value && /^[\p{L}\p{M}\p{N} .,'()&/-]+$/u.test(value);
}

export function availabilityPresentation(snapshot: AvailabilitySnapshot, scope: LocationScope, from: string, to: string,
                                         now: string, staffWorkEnabled = true): Result<AvailabilityPresentation, InvalidEvidence> {
  if (!snapshot || snapshot.kind !== "times" || snapshot.reservable !== false || !snapshot.scope ||
      snapshot.scope.tenantId !== scope.tenantId || snapshot.scope.clinicId !== scope.clinicId || snapshot.scope.locationId !== scope.locationId ||
      typeof snapshot.sourceRef !== "string" || !snapshot.sourceRef.trim() || snapshot.sourceRef.length > 256 ||
      typeof snapshot.timeZone !== "string" || !snapshot.timeZone.trim() || snapshot.timeZone.length > 128 ||
      !validDate(from) || !validDate(to) || Date.parse(`${to}T00:00:00Z`) < Date.parse(`${from}T00:00:00Z`) ||
      Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 7 * 86_400_000 ||
      typeof snapshot.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot.observedAt) ||
      !Number.isFinite(Date.parse(snapshot.observedAt)) ||
      !Number.isFinite(Date.parse(now)) || Date.parse(now) - Date.parse(snapshot.observedAt) > 30_000 ||
      Date.parse(snapshot.observedAt) - Date.parse(now) > 5_000 ||
      !Array.isArray(snapshot.startsAt) || snapshot.startsAt.length > 1_000) return err({ kind: "invalidEvidence" });
  if (snapshot.offering !== undefined && (!snapshot.offering ||
      !spokenName(snapshot.offering.practitionerName) ||
      !spokenName(snapshot.offering.appointmentTypeName))) return err({ kind: "invalidEvidence" });

  let dates: Intl.DateTimeFormat;
  let spoken: Intl.DateTimeFormat;
  try {
    dates = new Intl.DateTimeFormat("en-CA", { timeZone: snapshot.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    spoken = new Intl.DateTimeFormat("en-AU", { timeZone: snapshot.timeZone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "long" });
  } catch { return err({ kind: "invalidEvidence" }); }

  const startsAt: string[] = [];
  for (const candidate of snapshot.startsAt) {
    if (typeof candidate !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(candidate) ||
        !Number.isFinite(Date.parse(candidate))) return err({ kind: "invalidEvidence" });
    const instant = new Date(candidate);
    const date = localDate(instant, dates);
    if (date < from || date > to) return err({ kind: "invalidEvidence" });
    startsAt.push(instant.toISOString());
  }
  if (new Set(startsAt).size !== startsAt.length) return err({ kind: "invalidEvidence" });
  const shownStartsAt = startsAt.filter(start => Date.parse(start) > Date.parse(now)).sort().slice(0, 3);
  if (shownStartsAt.length === 0) return ok({ status: "empty", sourceRef: snapshot.sourceRef, timeZone: snapshot.timeZone, observedAt: snapshot.observedAt,
    shownStartsAt, text: staffWorkEnabled
      ? "I couldn't find a possible appointment time for those dates. I can request staff follow-up if you'd like."
      : "I couldn't find a possible appointment time for those dates. Please contact the clinic directly." });
  const labels = shownStartsAt.map(start => spoken.format(new Date(start)));
  const choice = snapshot.offering
    ? `For ${snapshot.offering.appointmentTypeName} with ${snapshot.offering.practitionerName}, the`
    : "The";
  return ok({ status: "shown", sourceRef: snapshot.sourceRef, timeZone: snapshot.timeZone, observedAt: snapshot.observedAt, shownStartsAt,
    text: `${choice} clinic's schedule currently shows possible times: ${labels.join("; ")} (${snapshot.timeZone}). These may change. I can't reserve or confirm an appointment from this information.` });
}
