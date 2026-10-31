import type { BookingSearchScope } from "./booking-search-preference.ts";
import { normalizedSpokenName } from "./pending-location.ts";
import { bookingSearchWindowText, matchesBookingSearchWindow, sameBookingSearchWindow, validBookingSearchWindow } from "./booking-search-window.ts";
import type { BookingSearchWindow } from "./booking-search-window.ts";
import { err, ok } from "./model.ts";
import type { BookableOffer, LocationScope, Result } from "./model.ts";
import { supportedVoiceLocale } from "./voice-presentation.ts";

/** Caller-facing evidence only. Opaque selections, proof and patient/provider IDs remain in the owning host. */
type BookingMenuEvidence = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string; observedAt: string; timeZone: string;
  practitionerName: string; appointmentTypeName: string; reservable: false;
  locationName?: string; searchScope?: BookingSearchScope;
  /** Current trusted host approval; legacy evidence retains the seven-day display bound. */
  maxSearchDays?: number;
  window?: BookingSearchWindow;
  choices: readonly Readonly<{ startsAt: string; endsAt: string; expiresAt: string }>[];
}>;
export type BookingMenuRead = BookingMenuEvidence & Readonly<{
  /** Fresh public evidence for the original member, never a selectable cached offer. */
  comparison?: Readonly<{ original: BookingMenuEvidence }>;
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
        typeof read.timeZone !== "string" || read.timeZone.length > 128 ||
        read.maxSearchDays !== undefined && (!Number.isSafeInteger(read.maxSearchDays) || read.maxSearchDays < 1 || read.maxSearchDays > 90) ||
        read.window !== undefined && !validBookingSearchWindow(read.window) || read.locationName !== undefined && !name(read.locationName)) return err({ kind: "invalidEvidence" });
    const clock = new Intl.DateTimeFormat(locale, { timeZone: read.timeZone, weekday: "long", day: "numeric", month: "long",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "long" });
    let search = "";
    if (read.searchScope) {
      const searched = read.searchScope, from = Date.parse(`${searched.from}T00:00:00.000Z`), to = Date.parse(`${searched.to}T00:00:00.000Z`);
      if (!name(searched.locationName) || searched.locationName !== read.locationName || !Array.isArray(searched.practitioners) ||
          searched.practitioners.length < 1 || searched.practitioners.length > 3 || !searched.practitioners.every(name) ||
          new Set(searched.practitioners.map(normalizedSpokenName)).size !== searched.practitioners.length ||
          !searched.practitioners.includes(read.practitionerName) || !["default", "preferred", "earliestApproved"].includes(searched.selection) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(searched.from) || !/^\d{4}-\d{2}-\d{2}$/.test(searched.to) ||
          !Number.isFinite(from) || !Number.isFinite(to) || new Date(from).toISOString().slice(0, 10) !== searched.from ||
          new Date(to).toISOString().slice(0, 10) !== searched.to || to < from || to - from > ((read.maxSearchDays ?? 7) - 1) * 86_400_000) return err({ kind: "invalidEvidence" });
      const day = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
      search = `I searched the approved practitioners ${searched.practitioners.join(" and ")} at ${searched.locationName}, from ${day.format(new Date(from))} through ${day.format(new Date(to))}. `;
      if (searched.selection === "earliestApproved" && read.choices.length) search += `The earliest eligible start I found in that search is option one. These options are with ${read.practitionerName}. `;
    }
    let prior = -Infinity;
    const choices: string[] = [];
    for (const choice of read.choices) {
      const start = instant(choice.startsAt), end = instant(choice.endsAt), expiry = instant(choice.expiresAt);
      if (start === undefined || end === undefined || expiry === undefined || start <= Math.max(at, observed) || start <= prior || end <= start ||
          end - start > 480 * 60_000 || !Number.isSafeInteger((end-start)/60_000) || expiry <= Math.max(at, observed) || !matchesBookingSearchWindow(choice.startsAt, read.timeZone, read.window)) return err({ kind: "invalidEvidence" });
      prior = start;
      choices.push(`option ${["one", "two", "three"][choices.length]}, ${clock.format(new Date(start))}, for ${(end-start)/60_000} minutes`);
    }
    let comparison = "";
    if (read.comparison !== undefined) {
      const original = read.comparison?.original, searched = read.searchScope;
      if (!original || Array.isArray(read.comparison) || Object.keys(read.comparison).join(",") !== "original" || "comparison" in original ||
          !searched || searched.selection !== "earliestApproved" || !read.choices.length ||
          original.practitionerName === read.practitionerName || !searched.practitioners.includes(original.practitionerName) ||
          original.appointmentTypeName !== read.appointmentTypeName || original.locationName !== read.locationName || original.timeZone !== read.timeZone ||
          original.searchScope?.selection !== "preferred" || original.searchScope.practitioners.length !== 1 ||
          original.searchScope.practitioners[0] !== original.practitionerName ||
          original.searchScope.from !== searched.from || original.searchScope.to !== searched.to ||
          !(original.window === undefined && read.window === undefined || sameBookingSearchWindow(original.window, read.window)) ||
          !bookingMenuPresentation(original, binding, now, locale).ok) return err({ kind: "invalidEvidence" });
      const inSearch = (startsAt: string) => {
        const parts = new Intl.DateTimeFormat("en", { timeZone: read.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
          .formatToParts(new Date(startsAt));
        const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)!.value;
        const date = `${part("year")}-${part("month")}-${part("day")}`;
        return date >= searched.from && date <= searched.to;
      };
      if (!read.choices.every(choice => inSearch(choice.startsAt)) || !original.choices.every(choice => inSearch(choice.startsAt)))
        return err({ kind: "invalidEvidence" });
      const first = original.choices[0], offered = read.choices[0]!;
      const description = `${original.appointmentTypeName} with ${original.practitionerName} at ${original.locationName}`;
      if (first) {
        if (Date.parse(first.startsAt) < Date.parse(offered.startsAt)) return err({ kind: "invalidEvidence" });
        comparison = `Your original choice, ${description}, has an eligible start on ${clock.format(new Date(first.startsAt))}, for ${(Date.parse(first.endsAt) - Date.parse(first.startsAt)) / 60_000} minutes. ` +
          (first.startsAt === offered.startsAt ? `${read.practitionerName} has an eligible start at the same time in this search. ` :
            `${read.practitionerName} has an earlier eligible start in this search. `);
      } else comparison = `For your original choice, ${description}, I couldn't find an eligible start in these searched dates. ${read.practitionerName} has an eligible start in this search. `;
      comparison += "You can ask to check your original practitioner again before choosing. ";
    }
    const constraint = read.window ? `I checked appointment start times ${bookingSearchWindowText(read.window)} in the clinic local time. ` : "";
    return ok(search + comparison + constraint + (choices.length ? `For ${read.appointmentTypeName} with ${read.practitionerName}${read.locationName ? ` at ${read.locationName}` : ""}, I can check ${choices.join("; ")}. `+
      `Which option would you like? These times may change and are not reserved.` : "I couldn't find an eligible booking time for those dates. Please contact the clinic directly."));
  } catch { return err({ kind: "invalidEvidence" }); }
}


/** Confirm the same provider/service/duration in the approved clinic calendar. Legacy hosts retain their wording. */
export function bookingConfirmation(offer: BookableOffer, locale: string): Result<string, Readonly<{ kind: "invalidEvidence" }>> {
  const presentation = offer.presentation, terms = offer.terms;
  if (terms && (typeof terms.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(terms.version) ||
      typeof terms.approvedText !== "string" || !terms.approvedText.trim() || terms.approvedText.length > 2000 ||
      /[\u0000-\u001f\u007f]/.test(terms.approvedText) || instant(terms.expiresAt) === undefined || terms.expiresAt !== offer.expiresAt)) return err({ kind: "invalidEvidence" });
  const suffix = terms ? ` ${terms.approvedText}` : "";
  if (!presentation) return ok(`Please confirm the ${offer.serviceRef} appointment at ${offer.startsAt}.${suffix}`);
  try {
    if (!supportedVoiceLocale(locale) || !name(presentation.practitionerName) || !name(presentation.appointmentTypeName) || presentation.locationName !== undefined && !name(presentation.locationName) ||
        !Number.isSafeInteger(presentation.durationMinutes) || presentation.durationMinutes < 1 || presentation.durationMinutes > 480 ||
        instant(offer.startsAt) === undefined || typeof presentation.timeZone !== "string" || presentation.timeZone.length > 128) return err({ kind: "invalidEvidence" });
    const at = new Intl.DateTimeFormat(locale, { timeZone: presentation.timeZone, weekday: "long", day: "numeric", month: "long",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "long" }).format(new Date(offer.startsAt));
    return ok(`Please confirm the ${presentation.appointmentTypeName} appointment with ${presentation.practitionerName}${presentation.locationName ? ` at ${presentation.locationName}` : ""} on ${at}, for ${presentation.durationMinutes} minutes.${suffix}`);
  } catch { return err({ kind: "invalidEvidence" }); }
}
