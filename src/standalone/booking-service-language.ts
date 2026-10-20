import { validBookingServiceChoice } from "../core/booking-service-choice.ts";
import type { BookingServiceChoice } from "../core/booking-service-choice.ts";

/** An explicit public request, never a classifier-inferred service or history.
 * The owner still resolves every field against the current approved catalogue. */
export function bookingServiceLanguage(text: string): BookingServiceChoice | undefined {
  const value = text.trim().replace(/[.!?]+$/, "");
  if (!value || value.length > 350 || /[\r\n"“”]/.test(value)) return undefined;
  const match = value.match(/^(?:Please book|Book|I want|I would like) (?:a|an) (\d{1,3}|thirty|forty five|forty-five|sixty|ninety)(?:-| )minute (initial|follow-up) (.+?) appointment(?:\. I am a returning patient, this is not a new problem, and my last visit was (\d{1,3}) months? ago)?$/i);
  if (!match) return undefined;
  const named: Record<string, number> = { thirty: 30, "forty five": 45, "forty-five": 45, sixty: 60, ninety: 90 };
  const durationMinutes = named[match[1]!.toLowerCase()] ?? Number(match[1]);
  const choice = { name: match[3]!, durationMinutes, visitKind: match[2]!.toLowerCase() === "initial" ? "initial" as const : "followUp" as const,
    ...(match[4] ? { returningPatient: true, newProblem: false, monthsSinceLastVisit: Number(match[4]) } : {}) };
  return validBookingServiceChoice(choice) ? choice : undefined;
}

/** Explicit corrections revoke an old choice; they cannot choose a replacement
 * type, assert a diagnosis or manufacture a verified treatment history. */
export function bookingEligibilityChanged(text: string): boolean {
  const value = text.trim().replace(/[.!?]+$/, "");
  return /^(?:Actually,? )?(?:(?:this|it) is a new (?:problem|issue)|(?:I am|I'm) (?:not a returning patient|a new patient)|my last visit was \d{1,4} months? ago|(?:I have not|I haven't) been (?:seen|here) (?:for|in) \d{1,4} months?)$/i.test(value);
}

export function bookingDurationLanguage(text: string): number | undefined {
  const value = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  const match = value.match(/^(?:i want|can i have|could i have|please change the appointment duration to) (?:a |an )?(one hour|one-hour|hour|hour and a half|one and a half hours|30-minute|45-minute|60-minute|90-minute|thirty-minute|forty-five-minute|sixty-minute|ninety-minute)(?: appointment)?(?: instead|,? please)?$/);
  if (!match) return undefined;
  if (["one hour", "one-hour", "hour"].includes(match[1]!)) return 60;
  if (["hour and a half", "one and a half hours"].includes(match[1]!)) return 90;
  return ({ "30-minute": 30, "45-minute": 45, "60-minute": 60, "90-minute": 90, "thirty-minute": 30,
    "forty-five-minute": 45, "sixty-minute": 60, "ninety-minute": 90 } as Record<string, number>)[match[1]!];
}
