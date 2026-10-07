import type { BookingClockWindow, BookingSearchClause, BookingSearchWindow } from "../core/booking-search-window.ts";
import { intersectBookingSearchWindow, validBookingSearchWindow } from "../core/booking-search-window.ts";

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ambiguous = { kind: "ambiguous" } as const;
const dayList = `(?:${weekdays.join("|")})(?: or (?:${weekdays.join("|")}))*`;
const dateToken = `(?:\\d{4}-\\d{2}-\\d{2}|(?:${months.join("|")}) \\d{1,2}(?:st|nd|rd|th)?)`;
const hourWords = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const minute = (text: string): number | undefined => {
  const match = text.match(/^(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?(?: (am|pm))?$/); if (!match) return undefined;
  let hour = /^\d+$/.test(match[1]!) ? Number(match[1]) : hourWords.indexOf(match[1]!); const minutes = Number(match[2] ?? 0);
  if (minutes > 59 || hour > 23 || match[3] && (hour < 1 || hour > 12) || !match[3] && hour <= 12) return undefined;
  if (match[3]) hour = hour % 12 + (match[3] === "pm" ? 12 : 0);
  return hour * 60 + minutes;
};
function clock(text: string): BookingClockWindow | undefined {
  const band = { morning: [0, 720], afternoon: [720, 1080], evening: [1080, 1440] }[text];
  if (band) return { startMinute: band[0]!, endMinute: band[1]!, startInclusive: true };
  const range = text.match(/^between (.+) and (.+)$/);
  if (range) { const start = minute(range[1]!), end = minute(range[2]!); return start !== undefined && end !== undefined && start < end ? { startMinute: start, endMinute: end, startInclusive: true } : undefined; }
  const both = text.match(/^(before|after) (.+) and (before|after) (.+)$/);
  if (both) {
    const a = clock(`${both[1]} ${both[2]}`), b = clock(`${both[3]} ${both[4]}`);
    const combined = a && b ? intersectBookingSearchWindow(a, b) : undefined;
    return combined && !("anyOf" in combined) ? combined : undefined;
  }
  const bound = text.match(/^(before|after) (.+)$/), at = bound ? minute(bound[2]!) : undefined;
  return at === undefined || bound![1] === "before" && at === 0 ? undefined : bound![1] === "before"
    ? { startMinute: 0, endMinute: at, startInclusive: true } : { startMinute: at, endMinute: 1440, startInclusive: false };
}
function date(text: string, today: string): string | undefined {
  const named = text.match(new RegExp(`^(${months.join("|")}) (\\d{1,2})(?:st|nd|rd|th)?$`));
  const value = named ? `${today.slice(0, 4)}-${String(months.indexOf(named[1]!) + 1).padStart(2, "0")}-${named[2]!.padStart(2, "0")}` : text;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value && value >= today ? value : undefined;
}
/** Bounded complete clauses; an unresolved alternative cannot be dropped. */
export function compoundBookingSearchLanguage(text: string, today: string) {
  const value = text.toLowerCase().trim().replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(?:actually|wait) /, "").replace(/^i can (?:only )?(?:come|attend|do) /, "").replace(/ please$/, "").trim();
  if (!new RegExp(`^(?:before|after|between|any day|${weekdays.join("|")}|${months.join("|")}|\\d{4}-\\d{2}-\\d{2})\\b`).test(value) ||
    !/\bor\b|^any day\b|^between\b|\band\b/.test(value)) return undefined;
  const finish = (clauses: readonly BookingSearchClause[]) => {
    const window: BookingSearchWindow = { anyOf: clauses };
    if (!validBookingSearchWindow(window)) return ambiguous;
    const dates = [...new Set(clauses.flatMap(clause => clause.dates ?? []))].sort();
    if (dates.length && clauses.some(clause => !clause.dates)) return ambiguous;
    const from = dates[0], to = dates.at(-1);
    if (from && to && Date.parse(to) - Date.parse(from) > 6 * 86_400_000) return ambiguous;
    return { kind: "window" as const, window, ...(from && to ? { from, to } : {}) };
  };
  const excluded = value.match(new RegExp(`^any day (?:except|apart from|but|other than) (${dayList})(?: (.+))?$`));
  if (excluded) {
    const denied = excluded[1]!.split(" or "), days = weekdays.flatMap((day, index) => denied.includes(day) ? [] : [index]);
    const window = excluded[2] ? clock(excluded[2]) : undefined;
    return excluded[2] && !window ? ambiguous : finish([{ weekdays: days, ...(window ? { window } : {}) }]);
  }
  const days = value.match(new RegExp(`^(${dayList})(?: (.+))?$`));
  if (days?.[1]?.includes(" or ")) {
    const window = days[2] ? clock(days[2]) : undefined;
    return days[2] && !window ? ambiguous : finish([{ weekdays: [...new Set(days[1].split(" or ").map(day => weekdays.indexOf(day)))], ...(window ? { window } : {}) }]);
  }
  const dateList = value.match(new RegExp(`^(${dateToken}(?: or ${dateToken})+)(?: (.+))?$`));
  if (dateList) {
    const dates = dateList[1]!.split(" or ").map(token => date(token, today)), window = dateList[2] ? clock(dateList[2]) : undefined;
    return dates.some(value => !value) || dateList[2] && !window ? ambiguous : finish([{ dates: [...new Set(dates as string[])], ...(window ? { window } : {}) }]);
  }
  const clauses = value.split(" or ").map(part => {
    const dated = part.match(new RegExp(`^(${dateToken})(?: (.+))?$`));
    const weekday = part.match(new RegExp(`^(${weekdays.join("|")})(?: (.+))?$`));
    const rest = dated ? dated[2] : weekday ? weekday[2] : part, window = rest ? clock(rest) : undefined;
    const foundDate = dated ? date(dated[1]!, today) : undefined;
    if (rest && !window || dated && !foundDate || !dated && !weekday && !window) return undefined;
    return { ...(foundDate ? { dates: [foundDate] } : {}), ...(weekday ? { weekdays: [weekdays.indexOf(weekday[1]!)] } : {}), ...(window ? { window } : {}) };
  });
  return clauses.some(clause => !clause) ? ambiguous : finish(clauses as BookingSearchClause[]);
}
