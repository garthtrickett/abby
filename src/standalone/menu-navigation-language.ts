import type { BookingMenuRead } from "../core/booking-menu.ts";
import type { BookingSearchWindow } from "../core/booking-search-window.ts";
import { clinicDateAt } from "./clinic-clock.ts";

type Navigation = Readonly<{ kind: "all" | "later" }> | Readonly<{ kind: "choice"; index: number }> |
  Readonly<{ kind: "day"; weekday: string }> | Readonly<{ kind: "date"; day: number }>;
const ambiguous = { kind: "clarify", reason: "menuAmbiguous" } as const;

/** Complete questions request evidence, never appointment selection. */
export function menuNavigationLanguage(text: string): Navigation | undefined {
  const value = text.toLowerCase().replace(/[’]/g, "'").replace(/[,.!?]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(?:(?:could you|can you|please) )?repeat (?:(?:those|the) (?:times|options)|that)(?: please)?$/.test(value)) return { kind: "all" };
  const day = value.match(/^(?:(?:could you|can you|please) )?repeat (?:the )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)(?:'s)? (?:options|times)(?: please)?$/);
  if (day) return { kind: "day", weekday: day[1]! };
  const choice = value.match(/^(?:what (?:was|is) (?:the )?|(?:(?:could you|can you) )?repeat (?:the )?)(first|second|third)(?: one| option| time)(?: please)?$/);
  if (choice) return { kind: "choice", index: ["first", "second", "third"].indexOf(choice[1]!) };
  const date = value.match(/^what (?:time )?(?:was|is) (?:the )?(\d{1,2})(?:st|nd|rd|th)?(?: one| time)?(?: please)?$/);
  if (date) return { kind: "date", day: Number(date[1]) };
  if (/^(?:what (?:was|is) the next (?:one|time|option)|(?:(?:could (?:it|that) be|is there|have you got|do you have) )?(?:anything |something )?(?:a bit )?later)(?: please)?$/.test(value)) return { kind: "later" };
  return undefined;
}

type Menu = Readonly<{ from: string; to: string; snapshot: Pick<BookingMenuRead, "choices" | "timeZone" | "window"> }>;
/** Derive a fresh bounded read from actually offered clocks/dates. The original
 * caller window is separate from a temporary one-minute repetition filter. */
export function menuNavigationQuery(request: Navigation, menu: Menu, callerWindow: BookingSearchWindow | null) {
  try {
    const { choices, timeZone } = menu.snapshot;
    if (request.kind === "all") return { kind: "read" as const, from: menu.from, to: menu.to, window: menu.snapshot.window ?? null };
    if (!choices.length) return { kind: "clarify", reason: "menuUnavailable" } as const;
    if (request.kind === "day" || request.kind === "date") {
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" });
      const dates = new Set(choices.flatMap(choice => {
        const at = new Date(choice.startsAt), date = clinicDateAt(timeZone, at);
        return request.kind === "day" ? weekday.format(at).toLowerCase() === request.weekday ? [date] : []
          : Number(date.slice(-2)) === request.day ? [date] : [];
      }));
      if (dates.size !== 1) return ambiguous;
      const date = [...dates][0]!;
      return { kind: "read" as const, from: date, to: date, window: menu.snapshot.window ?? null };
    }
    if (request.kind === "later" && choices.length !== 1) return ambiguous;
    const offered = choices[request.kind === "choice" ? request.index : 0];
    if (!offered) return ambiguous;
    const at = new Date(offered.startsAt);
    if (at.getUTCSeconds() || at.getUTCMilliseconds()) return ambiguous;
    const clock = new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const minute = Number(clock.find(part => part.type === "hour")?.value) * 60 + Number(clock.find(part => part.type === "minute")?.value);
    const date = clinicDateAt(timeZone, at), endMinute = Math.min(request.kind === "choice" ? minute + 1 : 1440, callerWindow?.endMinute ?? 1440);
    if (!Number.isSafeInteger(minute) || minute >= endMinute) return { kind: "clarify", reason: "menuRejected" } as const;
    return { kind: "read" as const, from: date, to: date,
      window: { startMinute: minute, endMinute, startInclusive: request.kind === "choice" } };
  } catch { return ambiguous; }
}
