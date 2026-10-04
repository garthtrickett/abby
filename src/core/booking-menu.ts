import { err, ok } from "./model.ts";
import type { BookableOffer, LocationScope, Result } from "./model.ts";
import { supportedVoiceLocale } from "./voice-presentation.ts";

/** Caller-facing evidence only. Opaque selections, proof and patient/provider IDs remain in the owning host. */
export type BookingMenuRead = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; observedAt: string; timeZone: string;
  practitionerName: string; appointmentTypeName: string; reservable: false;
  choices: readonly Readonly<{ startsAt: string; endsAt: string; expiresAt: string }>[];
}>;
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 120 &&
  value.trim() === value && /^[\p{L}\p{M}\p{N} .,'()&/-]+$/u.test(value);
const instant = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const at = Date.parse(value); return Number.isFinite(at) && new Date(at).toISOString() === value ? at : undefined;
};
export function bookingMenuPresentation(read: BookingMenuRead, binding: Readonly<{ scope: LocationScope; callId: string;
  sessionId: string; policyVersion: string }>, now: string, locale = "en-AU"): Result<string, Readonly<{ kind: "invalidEvidence" }>> {
  try {
    const at = instant(now), observed = instant(read.observedAt);
    if (!supportedVoiceLocale(locale) || read.reservable !== false || read.scope.tenantId !== binding.scope.tenantId ||
        read.scope.clinicId !== binding.scope.clinicId || read.scope.locationId !== binding.scope.locationId ||
        read.callId !== binding.callId || read.sessionId !== binding.sessionId || read.policyVersion !== binding.policyVersion ||
        at === undefined || observed === undefined || Math.abs(observed - at) > 30_000 ||
        !name(read.practitionerName) || !name(read.appointmentTypeName) || !Array.isArray(read.choices) || read.choices.length > 3 ||
        typeof read.timeZone !== "string" || read.timeZone.length > 128) return err({ kind: "invalidEvidence" });
    const clock = new Intl.DateTimeFormat(locale, { timeZone: read.timeZone, weekday: "long", day: "numeric", month: "long",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "long" });
    let prior = -Infinity;
    const choices: string[] = [];
    for (const choice of read.choices) {
      const start = instant(choice.startsAt), end = instant(choice.endsAt), expiry = instant(choice.expiresAt);
      if (start === undefined || end === undefined || expiry === undefined || start <= Math.max(at, observed) || start <= prior || end <= start ||
          end - start > 480 * 60_000 || !Number.isSafeInteger((end-start)/60_000) || expiry <= Math.max(at, observed)) return err({ kind: "invalidEvidence" });
      prior = start;
      choices.push(`option ${["one", "two", "three"][choices.length]}, ${clock.format(new Date(start))}, for ${(end-start)/60_000} minutes`);
    }
    return ok(choices.length ? `For ${read.appointmentTypeName} with ${read.practitionerName}, I can check ${choices.join("; ")}. `+
      `Which option would you like? These times may change and are not reserved.` : "I couldn't find an eligible booking time for those dates. Please contact the clinic directly.");
  } catch { return err({ kind: "invalidEvidence" }); }
}


/** Confirm the same provider/service/duration in the approved clinic calendar. Legacy hosts retain their wording. */
export function bookingConfirmation(offer: BookableOffer, locale: string): Result<string, Readonly<{ kind: "invalidEvidence" }>> {
  const presentation = offer.presentation;
  if (!presentation) return ok(`Please confirm the ${offer.serviceRef} appointment at ${offer.startsAt}.`);
  try {
    if (!supportedVoiceLocale(locale) || !name(presentation.practitionerName) || !name(presentation.appointmentTypeName) ||
        !Number.isSafeInteger(presentation.durationMinutes) || presentation.durationMinutes < 1 || presentation.durationMinutes > 480 ||
        instant(offer.startsAt) === undefined || typeof presentation.timeZone !== "string" || presentation.timeZone.length > 128) return err({ kind: "invalidEvidence" });
    const at = new Intl.DateTimeFormat(locale, { timeZone: presentation.timeZone, weekday: "long", day: "numeric", month: "long",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "long" }).format(new Date(offer.startsAt));
    return ok(`Please confirm the ${presentation.appointmentTypeName} appointment with ${presentation.practitionerName} on ${at}, for ${presentation.durationMinutes} minutes.`);
  } catch { return err({ kind: "invalidEvidence" }); }
}
