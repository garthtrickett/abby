import type { BookingMenuRead } from "../core/booking-menu.ts";
import type { CallState, MenuClarificationReason } from "../core/model.ts";
import { noticePresentationId } from "../core/transition.ts";
import type { VoiceIntent } from "../voice/voice-session.ts";

type Menu = Readonly<{ kind: "booking" | "rescheduling"; stage: "targets" | "offers" | null;
  turnId: string; snapshot: Pick<BookingMenuRead, "choices" | "timeZone"> }>;
type Selection = Readonly<{ kind: "choice"; choice: 1 | 2 | 3 }> | Readonly<{ kind: "clarify"; reason: MenuClarificationReason }> | Readonly<{ kind: "notSelection" }>;
const hours = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const clarify = { kind: "clarify", reason: "menuAmbiguous" } as const;

function choice(index: number, count: number): Selection {
  return index >= 0 && index < Math.min(count, 3) ? { kind: "choice", choice: (index + 1) as 1 | 2 | 3 } : clarify;
}
/** Bounded caller syntax, never a fuzzy/phonetic guess or a model-supplied ordinal. */
function match(text: string, menu: Menu): Selection {
  const value = text.toLowerCase().trim().replace(/[-,.!?]/g, " ").replace(/\s+/g, " ").trim();
  if (/\b(?:none of those|none of them|neither|not those)\b/.test(value)) return { kind: "clarify", reason: "menuRejected" };
  const ordinal = value.match(/^(?:(?:the|my|move it to|book) )?(?:option )?(first|second|third|one|two|three|1|2|3)(?: (?:existing appointment|appointment|time|one))?(?: (?:please|thanks))?$/);
  if (ordinal) return choice(["first", "one", "1"].includes(ordinal[1]!) ? 0 : ["second", "two", "2"].includes(ordinal[1]!) ? 1 : 2, menu.snapshot.choices.length);
  const relative = value.match(/^(?:the )?(earlier|later|last) (?:one|time|appointment)(?: (?:please|thanks|would be better))?$/);
  if (relative) {
    const count = menu.snapshot.choices.length;
    if (relative[1] !== "last" && count !== 2) return clarify;
    return choice(relative[1] === "earlier" ? 0 : count - 1, count);
  }
  const time = value.match(/^(?:the )?(?:(half past) (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)|(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2})| (thirty|o'clock))?)(?: (am|pm|in the morning|in the afternoon|in the evening))?(?: (?:appointment|one|time))?(?: (?:please|thanks))?$/);
  if (!time) return { kind: "notSelection" };
  const token = time[2] ?? time[3]!, hour = /^\d+$/.test(token) ? Number(token) : hours.indexOf(token);
  const minute = time[1] || time[5] === "thirty" ? 30 : Number(time[4] ?? 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return clarify;
  const period = time[6];
  if (period && (hour < 1 || hour > 12)) return clarify;
  const exactHour = period ? hour % 12 + (period === "am" || period === "in the morning" ? 0 : 12) : hour;
  try {
    const clock = new Intl.DateTimeFormat("en-AU", { timeZone: menu.snapshot.timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h23" });
    const found = menu.snapshot.choices.flatMap((option, index) => {
      const parts = clock.formatToParts(new Date(option.startsAt));
      const optionHour = Number(parts.find(part => part.type === "hour")?.value), optionMinute = Number(parts.find(part => part.type === "minute")?.value);
      return optionMinute === minute && (period || hour > 12 ? optionHour === exactHour : optionHour % 12 === hour % 12) ? [index] : [];
    });
    return found.length === 1 ? choice(found[0]!, menu.snapshot.choices.length) : clarify;
  } catch { return clarify; }
}

/** Facts stay private to the volatile owner. A selection is bound to the latest
 * processed notice, its played receipt and unexpired offers, then passes through
 * the ordinary host selection/proposal seam for private proof revalidation. */
export class PlayedMenuSelection {
  #menu: Menu | undefined;
  #previous: Readonly<{ menu: Menu; selectionTurnId: string; selectedStartsAt: string }> | undefined;
  remember(menu: Menu): void { this.#previous = undefined; this.#menu = structuredClone(menu); }
  clear(): void { this.#menu = undefined; this.#previous = undefined; }
  consumed(turnId: string, choice: 1 | 2 | 3): void {
    const menu = this.#menu, selected = menu?.snapshot.choices[choice - 1];
    this.#previous = menu && selected ? { menu, selectionTurnId: turnId, selectedStartsAt: selected.startsAt } : undefined;
    this.#menu = undefined;
  }
  correction(text: string, state: CallState, now: string) {
    const previous = this.#previous, action = Object.values(state.actions).at(-1);
    const expectedKind = previous?.menu.kind === "booking" ? "book" : "reschedule";
    if (!previous || previous.menu.kind === "rescheduling" && previous.menu.stage !== "offers" || !action || action.kind !== expectedKind ||
        action.mutation.request.kind !== expectedKind || !("offer" in action.mutation.request) ||
        !["awaitingConfirmation", "canceled"].includes(action.status) ||
        action.mutation.request.offer.startsAt !== previous.selectedStartsAt || state.processedTurnIds.at(-1) !== previous.selectionTurnId ||
        state.presentations[noticePresentationId(state.callId, previous.menu.turnId)]?.status !== "played") return undefined;
    const value = text.trim().replace(/^(?:(?:wait|actually|no)[,.]?\s*)+/i, "");
    const selection = match(value, previous.menu);
    if (selection.kind === "notSelection") return undefined;
    if (selection.kind === "clarify") return { kind: "clarify" as const, reason: selection.reason };
    const selected = previous.menu.snapshot.choices[selection.choice - 1]!;
    if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(selected.expiresAt)) ||
        Date.parse(selected.expiresAt) <= Date.parse(now)) return { kind: "clarify" as const, reason: "menuUnavailable" as const };
    return { kind: "correction" as const, menuKind: previous.menu.kind, menuTurnId: previous.menu.turnId, startsAt: selected.startsAt };
  }
  corrected(turnId: string, startsAt: string): void {
    if (this.#previous) this.#previous = { ...this.#previous, selectionTurnId: turnId, selectedStartsAt: startsAt };
  }
  resolve(text: string, state: CallState, now: string): VoiceIntent | undefined {
    const menu = this.#menu; if (!menu) return undefined;
    const result = match(text, menu); if (result.kind === "notSelection") return undefined;
    const notice = state.presentations[noticePresentationId(state.callId, menu.turnId)];
    if (state.lifecycle !== "active" || state.pendingPresentationId ||
        state.processedTurnIds.at(-1) !== menu.turnId || notice?.kind !== "notice" || notice.status !== "played" ||
        !Number.isFinite(Date.parse(now)) || menu.snapshot.choices.some(option => !Number.isFinite(Date.parse(option.expiresAt)) || Date.parse(option.expiresAt) <= Date.parse(now))) return { kind: "clarify", reason: "menuUnavailable" };
    if (result.kind === "clarify") return result;
    return menu.kind === "booking" ? { kind: "bookingChoice", choice: result.choice }
      : menu.stage ? { kind: "reschedulingChoice", stage: menu.stage, choice: result.choice } : clarify;
  }
}
