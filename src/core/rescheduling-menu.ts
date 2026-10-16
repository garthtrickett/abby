import { bookingMenuPresentation } from "./booking-menu.ts";
import type { BookingMenuRead } from "./booking-menu.ts";
import { err, ok } from "./model.ts";
import type { Result } from "./model.ts";
import { supportedVoiceLocale } from "./voice-presentation.ts";
import { normalizedSpokenName } from "./spoken-name.ts";

export type ReschedulingMenuStage = "targets" | "practitioners" | "offers";
export type ReschedulingPractitionerRead = Omit<BookingMenuRead, "choices" | "practitionerName" | "appointmentTypeName" | "window"> & Readonly<{
  stage: "practitioners" | "selectedPractitioner"; hasMore: boolean; window?: never;
  choices: readonly Readonly<{ name: string; expiresAt: string }>[];
}>;
export type ReschedulingMenuRead = (BookingMenuRead & Readonly<{ stage: "offers"; practitionerSwitchAvailable?: true }>) |
  (Omit<BookingMenuRead, "practitionerName" | "appointmentTypeName"> & Readonly<{ stage: "targets" | "selectedTarget" }>) | ReschedulingPractitionerRead;
const instant = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const at = Date.parse(value); return Number.isFinite(at) && new Date(at).toISOString() === value ? at : undefined;
};

/** Safe menu facts only. Provider IDs and private mappings never cross this SAM read seam. */
export function reschedulingMenuPresentation(read: ReschedulingMenuRead, binding: Pick<BookingMenuRead,
  "scope" | "callId" | "sessionId" | "policyVersion">, now: string, locale = "en-AU"): Result<string, Readonly<{ kind: "invalidEvidence" }>> {
  try {
    if (read.stage === "practitioners" || read.stage === "selectedPractitioner") {
      const at = instant(now), observed = instant(read.observedAt);
      if (!supportedVoiceLocale(locale) || read.reservable !== false || read.scope.tenantId !== binding.scope.tenantId ||
          read.scope.clinicId !== binding.scope.clinicId || read.scope.locationId !== binding.scope.locationId ||
          read.callId !== binding.callId || read.sessionId !== binding.sessionId || read.policyVersion !== binding.policyVersion ||
          at === undefined || observed === undefined || Math.abs(observed-at) > 30_000 || typeof read.hasMore !== "boolean" ||
          !Array.isArray(read.choices) || read.choices.length > 3 || read.stage === "selectedPractitioner" && read.choices.length !== 1 ||
          read.choices.some(choice => !normalizedSpokenName(choice.name) || instant(choice.expiresAt) === undefined || Date.parse(choice.expiresAt) <= Math.max(at, observed)) ||
          new Set(read.choices.map(choice => normalizedSpokenName(choice.name))).size !== read.choices.length) return err({ kind: "invalidEvidence" });
      if (read.stage === "selectedPractitioner") return ok(`You've chosen ${read.choices[0]!.name}. What dates would you like to check with them? Your appointment has not been moved.`);
      return ok(read.choices.length ? `Which practitioner would you like to check? ${read.choices.map((choice, i) => `Option ${["one", "two", "three"][i]}, ${choice.name}`).join("; ")}. ${read.hasMore ? 'To hear more, say "other practitioners". ' : ""}Your appointment remains unchanged.` :
        "I couldn't find an approved practitioner to switch to. Your appointment remains unchanged. Please contact the clinic directly.");
    }
    if (read.stage === "offers") {
      const result = bookingMenuPresentation(read, binding, now, locale);
      return result.ok ? ok(result.value.replace("eligible booking time", "eligible new appointment time") +
        (read.choices.length === 0 && read.practitionerSwitchAvailable === true ? " Would you like to check other approved practitioners? Your appointment remains unchanged." : "")) : result;
    }
    const at = instant(now), observed = instant(read.observedAt);
    if (!["targets", "selectedTarget"].includes(read.stage) || !supportedVoiceLocale(locale) || read.reservable !== false ||
        read.scope.tenantId !== binding.scope.tenantId || read.scope.clinicId !== binding.scope.clinicId || read.scope.locationId !== binding.scope.locationId ||
        read.callId !== binding.callId || read.sessionId !== binding.sessionId || read.policyVersion !== binding.policyVersion ||
        at === undefined || observed === undefined || Math.abs(observed-at) > 30_000 || !Array.isArray(read.choices) || read.choices.length > 3 ||
        (read.stage === "selectedTarget" && read.choices.length !== 1) || typeof read.timeZone !== "string" || read.timeZone.length > 128) return err({ kind: "invalidEvidence" });
    const clock = new Intl.DateTimeFormat(locale, { timeZone: read.timeZone, weekday: "long", day: "numeric", month: "long",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "long" });
    const options: string[] = []; let prior = -Infinity;
    for (const choice of read.choices) {
      const start = instant(choice.startsAt), end = instant(choice.endsAt), expiry = instant(choice.expiresAt);
      if (start === undefined || end === undefined || expiry === undefined || start <= Math.max(at, observed) || start <= prior ||
          end <= start || end-start > 480*60_000 || !Number.isSafeInteger((end-start)/60_000) || expiry <= Math.max(at, observed)) return err({ kind: "invalidEvidence" });
      prior = start; options.push(`${clock.format(new Date(start))}, for ${(end-start)/60_000} minutes`);
    }
    if (read.stage === "selectedTarget") return ok(`You've selected your appointment on ${options[0]}. What dates would you like to move it to? No appointment has been moved.`);
    return ok(options.length ? `Which appointment would you like to move? ${options.map((value,i) => `Option ${["one","two","three"][i]}, ${value}`).join("; ")}.` :
      "I couldn't find an eligible appointment to move. Please contact the clinic directly.");
  } catch { return err({ kind: "invalidEvidence" }); }
}
