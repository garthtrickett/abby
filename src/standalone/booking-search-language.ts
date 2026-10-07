import type { BookingSearchWindow } from "../core/booking-search-window.ts";
import { compoundBookingSearchLanguage } from "./compound-booking-search-language.ts";

type Search = Readonly<{ kind: "window"; window: BookingSearchWindow | null; date?: string; from?: string; to?: string }> |
  Readonly<{ kind: "laterWeek" }> | Readonly<{ kind: "ambiguous" }>;
const ambiguous = { kind: "ambiguous" } as const;
const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
function minute(text: string): number | undefined {
  const match = text.match(/^(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?(?: (am|pm))?$/);
  if (!match) return undefined;
  let hour = /^\d+$/.test(match[1]!) ? Number(match[1]) : words.indexOf(match[1]!);
  const minutes = Number(match[2] ?? 0);
  if (minutes > 59 || hour > 23) return undefined;
  if (match[3]) { if (hour < 1 || hour > 12) return undefined; hour = hour % 12 + (match[3] === "pm" ? 12 : 0); }
  // This explicit common phrase is disclosed as 4 pm in the new menu. Other
  // unqualified 12-hour values need clarification rather than an am/pm guess.
  else if (text === "four" || text === "4") hour = 16;
  else if (hour <= 12) return undefined;
  return hour * 60 + minutes;
}
/** Only bounded caller syntax. The model never supplies clock constraints. */
export function bookingSearchLanguage(text: string, today: string): Search | undefined {
  const compound = compoundBookingSearchLanguage(text, today);
  if (compound) return compound;
  let value = text.toLowerCase().trim().replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(?:none of those work |none of those |not those )?(?:is there something |anything )?later (?:that|this) week$/.test(value)) return { kind: "laterWeek" };
  value = value.replace(/\s+after all$/, "").trim();
  const hasWindow = /\b(?:after|before|morning|afternoon|evening|any time|anytime|between)\b/.test(value);
  if (!hasWindow) return undefined;
  value = value.replace(/^(?:actually|wait) /, "").replace(/^that day is fine but /, "")
    .replace(/^i can only (?:come|attend) /, "").replace(/^(?:what about|make (?:it|that)) /, "").replace(/ please$/, "");
  let date: string | undefined;
  const dated = value.match(/^(\d{4}-\d{2}-\d{2}|sunday|monday|tuesday|wednesday|thursday|friday|saturday) (.+)$/);
  if (dated) {
    const at = Date.parse(`${today}T00:00:00.000Z`);
    if (!Number.isFinite(at)) return ambiguous;
    if (/^\d/.test(dated[1]!)) {
      const time = Date.parse(`${dated[1]}T00:00:00.000Z`);
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== dated[1] || time < at) return ambiguous;
      date = dated[1];
    } else {
      const index = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(dated[1]!);
      date = new Date(at + ((index - new Date(at).getUTCDay() + 7) % 7) * 86_400_000).toISOString().slice(0, 10);
    }
    value = dated[2]!;
  }
  const result = (window: BookingSearchWindow | null): Search => ({ kind: "window", window, ...(date ? { date } : {}) });
  if (["any time", "anytime", "any time is fine", "anytime is fine"].includes(value)) return result(null);
  const band = { morning: [0, 720], afternoon: [720, 1080], evening: [1080, 1440] }[value];
  if (band) return result({ startMinute: band[0]!, endMinute: band[1]!, startInclusive: true });
  const bound = value.match(/^(after|before) (.+)$/);
  if (!bound) return ambiguous;
  const at = minute(bound[2]!);
  if (at === undefined || bound[1] === "before" && at === 0) return ambiguous;
  return result(bound[1] === "after" ? { startMinute: at, endMinute: 1440, startInclusive: false } :
    { startMinute: 0, endMinute: at, startInclusive: true });
}
