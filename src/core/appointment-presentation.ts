import { supportedVoiceLocale } from "./voice-presentation.ts";
import { err, ok } from "./model.ts";
import type { AppointmentRead, LocationScope, Result } from "./model.ts";

type Presentation = Readonly<{ text: string; status: "shown" | "empty"; sourceRef: string; shownCount: number }>;

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function millis(value: string): number | undefined {
  const parsed = Date.parse(value);
  return typeof value === "string" && Number.isFinite(parsed) ? parsed : undefined;
}

/** Converts a complete, recently verified host read into limited caller-safe wording. */
export function appointmentPresentation(snapshot: AppointmentRead, scope: LocationScope, from: string, to: string, now: string, locale = "en-AU", declareRange = false): Result<Presentation, Readonly<{ kind: "invalidEvidence" }>> {
  const fromMs = millis(from);
  const toMs = millis(to);
  const nowMs = millis(now);
  const observedMs = millis(snapshot?.observedAt);
  const expiresMs = millis(snapshot?.proofExpiresAt);
  if (!supportedVoiceLocale(locale) || !snapshot || !snapshot.scope || !sameScope(snapshot.scope, scope) ||
      !snapshot.sourceRef || snapshot.sourceRef.length > 256 || !snapshot.patientRef || !snapshot.verificationRef ||
      fromMs === undefined || toMs === undefined || nowMs === undefined || observedMs === undefined || expiresMs === undefined ||
      toMs <= fromMs || expiresMs <= nowMs || observedMs > nowMs || nowMs - observedMs > 120_000 ||
      !Array.isArray(snapshot.appointments) || snapshot.appointments.length > 500 ||
      typeof snapshot.timeZone !== "string" || !snapshot.timeZone.trim()) return err({ kind: "invalidEvidence" });
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat(locale, { timeZone: snapshot.timeZone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }); }
  catch { return err({ kind: "invalidEvidence" }); }
  const seen = new Set<string>();
  const times: number[] = [];
  for (const appointment of snapshot.appointments) {
    const start = millis(appointment?.startsAt);
    const end = millis(appointment?.endsAt);
    if (!appointment || !appointment.appointmentRef || appointment.appointmentRef.length > 256 || seen.has(appointment.appointmentRef) ||
        start === undefined || end === undefined || end <= start || start <= fromMs || start >= toMs) return err({ kind: "invalidEvidence" });
    seen.add(appointment.appointmentRef);
    times.push(start);
  }
  times.sort((left, right) => left - right);
  const dates = new Intl.DateTimeFormat(locale, { timeZone: snapshot.timeZone, day: "numeric", month: "long", year: "numeric" });
  const rangeText = declareRange ? `I checked upcoming appointments between ${dates.format(new Date(fromMs))} and ${dates.format(new Date(toMs))}. ` : "";
  if (times.length === 0) return ok({ text: `${rangeText}I couldn't find an appointment in that time range.`, status: "empty", sourceRef: snapshot.sourceRef, shownCount: 0 });
  const shown = times.slice(0, 3).map(time => formatter.format(new Date(time)));
  const numbered = shown.map((time, index) => `option ${["one", "two", "three"][index]}, ${time}`);
  const text = times.length === 1
    ? `I found an appointment on ${shown[0]}.`
    : `I found ${times.length} appointments in that time range. The first ${shown.length} are ${numbered.join("; ")}.`;
  return ok({ text: rangeText + text, status: "shown", sourceRef: snapshot.sourceRef, shownCount: shown.length });
}
