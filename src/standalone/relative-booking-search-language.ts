import { bookingSearchLanguage } from "./booking-search-language.ts";
import type { BookingSearchWindow } from "../core/booking-search-window.ts";

const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ambiguous = { kind: "ambiguous" } as const;
const dateAt = (at: number) => new Date(at).toISOString().slice(0, 10);
const millis = (date: string) => {
  const at = Date.parse(`${date}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(at) && dateAt(at) === date ? at : undefined;
};
function clockWindow(text: string): BookingSearchWindow | null | undefined {
  const exact = text.match(/^at (\d{1,2})(?::(\d{2}))? (am|pm)$/);
  if (exact) {
    const hour = Number(exact[1]), minute = Number(exact[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return undefined;
    const startMinute = (hour % 12 + (exact[3] === "pm" ? 12 : 0)) * 60 + minute;
    return { startMinute, endMinute: startMinute + 1, startInclusive: true };
  }
  const parsed = bookingSearchLanguage(text, "2000-01-01");
  return parsed?.kind === "window" && !parsed.date && !parsed.from ? parsed.window : undefined;
}
export type RelativeSearch = Readonly<{ kind: "range"; from: string; to: string; window?: BookingSearchWindow | null }> |
  Readonly<{ kind: "source"; days?: number; deltaMinute?: number; date?: string }> | typeof ambiguous;
/** Calendar calculations request fresh menus. They never select an offer or
 * recover a source appointment from caller claims/model context. */
export function relativeBookingSearchLanguage(text: string, today: string): RelativeSearch | undefined {
  const value = text.toLowerCase().trim().replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(?:actually|wait) /, "").replace(/ please$/, "").trim();
  const sourceNext = /^(?:the )?same (?:time|day and time) next week$/.test(value);
  if (sourceNext) return { kind: "source", days: 7 };
  const sourceDate = value.match(/^(?:the )?same time on (\d{4}-\d{2}-\d{2})$/);
  if (sourceDate) return millis(sourceDate[1]!) !== undefined && sourceDate[1]! >= today ? { kind: "source", date: sourceDate[1]! } : ambiguous;
  const sourceClock = value.match(/^(thirty|30) minutes (earlier|later) on the same day$/);
  if (sourceClock) return { kind: "source", deltaMinute: sourceClock[2] === "earlier" ? -30 : 30 };
  if (/^(?:the )?same (?:time|day)\b|^(?:thirty|30) minutes\b/.test(value)) return ambiguous;
  const at = millis(today); if (at === undefined) return ambiguous;
  const range = (from: string, to: string, rest?: string): RelativeSearch => {
    const window = rest ? clockWindow(rest) : undefined;
    if (from < today || rest && window === undefined) return ambiguous;
    return { kind: "range", from, to, ...(window !== undefined ? { window } : {}) };
  };
  const week = value.match(/^next week(?: (.+))?$/);
  if (week) { const offset = (8 - new Date(at).getUTCDay()) % 7 || 7, from = at + offset * 86_400_000; return range(dateAt(from), dateAt(from + 6 * 86_400_000), week[1]); }
  const weeks = value.match(/^(?:in )?(one|two|1|2) weeks?(?: (.+))?$/);
  if (weeks) { const from = dateAt(at + (["two", "2"].includes(weeks[1]!) ? 14 : 7) * 86_400_000); return range(from, from, weeks[2]); }
  const month = value.match(/^(?:in )?a month(?: (.+))?$/);
  if (month) {
    const next = new Date(at), day = next.getUTCDate(); next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(day);
    const expected = (new Date(at).getUTCMonth() + 1) % 12;
    return next.getUTCMonth() === expected ? range(dateAt(next.getTime()), dateAt(next.getTime()), month[1]) : ambiguous;
  }
  // Alternatives belong to the compound parser; do not treat its remaining
  // clauses as an unknown single-date qualifier.
  if (/\bor\b/.test(value)) return undefined;
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})(?: (.+))?$/);
  if (iso) return millis(iso[1]!) === undefined ? ambiguous : range(iso[1]!, iso[1]!, iso[2]);
  const dated = value.match(new RegExp(`^(?:(${days.join("|")}) )?(?:(${months.join("|")}) (\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)? (${months.join("|")}))(?: (.+))?$`));
  if (dated) {
    const month = months.indexOf(dated[2] ?? dated[5]!), day = Number(dated[3] ?? dated[4]);
    const date = `${today.slice(0, 4)}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`, found = millis(date);
    return found === undefined || dated[1] && new Date(found).getUTCDay() !== days.indexOf(dated[1]) ? ambiguous : range(date, date, dated[6]);
  }
  const weekday = value.match(new RegExp(`^(?:(this|next) )?(${days.join("|")})(?: (.+))?$`));
  if (weekday && !/\bor\b/.test(value)) {
    const day = days.indexOf(weekday[2]!), current = new Date(at).getUTCDay();
    const offset = weekday[1] === "next" ? ((8 - current) % 7 || 7) + (day + 6) % 7 : weekday[1] === "this"
      ? (day + 6) % 7 - (current + 6) % 7 : (day - current + 7) % 7;
    const date = dateAt(at + offset * 86_400_000); return range(date, date, weekday[3]);
  }
  return /^(?:next|this|in)\b|^(?:a month|one week|two weeks)\b/.test(value) ? ambiguous : undefined;
}
