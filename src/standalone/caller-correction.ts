import type { BookingSearchWindow } from "../core/booking-search-window.ts";
import { bookingSearchLanguage } from "./booking-search-language.ts";

/** Deliberately bounded public correction language. Unrecognized qualifiers
 * require clarification rather than silently discarding a time constraint. */
export function callerCorrection(text: string, today: string): Readonly<{ kind: "date"; date: string; window?: BookingSearchWindow | null }> |
  Readonly<{ kind: "stop" }> | undefined {
  const value = text.toLowerCase().trim();
  const marker = value.lastIndexOf("actually");
  const part = (marker >= 0 ? value.slice(marker + "actually".length) : value)
    .replace(/^[,\s]+/, "").replace(/^(?:make (?:that|it)|change (?:that|it) to)\s+/, "")
    .replace(/[.!?]+$/, "").trim();
  if (marker >= 0 || /^(?:no\b|wait\b|hold on\b|change (?:that|it) to\b|make (?:that|it)\b)/.test(value)) {
    const search = bookingSearchLanguage(part, today);
    if (search?.kind === "window" && search.date) return { kind: "date", date: search.date, window: search.window };
    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const index = weekdays.indexOf(part), at = Date.parse(`${today}T00:00:00.000Z`);
    if (index >= 0 && Number.isFinite(at)) {
      const offset = (index - new Date(at).getUTCDay() + 7) % 7;
      return { kind: "date", date: new Date(at + offset * 86_400_000).toISOString().slice(0, 10) };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(part)) {
      const day = Date.parse(`${part}T00:00:00.000Z`);
      if (Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === part && day >= at) return { kind: "date", date: part };
    }
    return { kind: "stop" };
  }
  // A mixed affirmative/negative is never a confirmation, even if it begins yes.
  return /^yes\b.*\b(?:no|wait|hold on|cannot|can't)\b/.test(value) ? { kind: "stop" } : undefined;
}
