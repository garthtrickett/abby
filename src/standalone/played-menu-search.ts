import type { BookingMenuRead } from "../core/booking-menu.ts";
import type { CallState } from "../core/model.ts";
import { noticePresentationId } from "../core/transition.ts";
import type { VoiceIntent } from "../voice/voice-session.ts";
import { bookingSearchLanguage } from "./booking-search-language.ts";
import { clinicDateAt } from "./clinic-clock.ts";

type Menu = Readonly<{ turnId: string; from: string; to: string; kind: "booking" | "rescheduling";
  snapshot: Pick<BookingMenuRead, "choices" | "timeZone"> }>;
const denied = { kind: "clarify", reason: "menuUnavailable" } as const;
/** Volatile search dates belong to the played menu, not to model context. Each
 * result goes through fresh host reads and the usual selection/confirmation. */
export class PlayedMenuSearch {
  #menu: Menu | undefined;
  remember(menu: Menu): void { this.#menu = structuredClone(menu); }
  clear(): void { this.#menu = undefined; }
  resolve(text: string, state: CallState, today: string, timeZone: string, kind: "booking" | "rescheduling"): VoiceIntent | undefined {
    const request = bookingSearchLanguage(text, today);
    if (!request) return undefined;
    if (request.kind === "ambiguous") return { kind: "clarify", reason: "menuAmbiguous" };
    const action = Object.values(state.actions).at(-1);
    if (action && action.kind !== "intake" && ["committed", "uncertain", "needsReview", "dispatched"].includes(action.status)) return { kind: "clarify", reason: "changeAfterSend" };
    const menu = this.#menu;
    const played = menu?.kind === kind && state.presentations[noticePresentationId(state.callId, menu.turnId)]?.status === "played";
    const current = played && !state.pendingPresentationId && state.processedTurnIds.at(-1) === menu.turnId;
    const requestOffer = action && "offer" in action.mutation.request ? action.mutation.request.offer : undefined;
    const correcting = played && action?.status === "canceled" &&
      (action.mutation.request.kind === "book" || action.mutation.request.kind === "reschedule") &&
      !!requestOffer && menu.snapshot.choices.some(choice => choice.startsAt === requestOffer.startsAt);
    let from: string, to: string;
    if (request.kind === "laterWeek") {
      if (!current || !menu) return denied;
      const end = Date.parse(`${menu.to}T00:00:00.000Z`), days = (7 - new Date(end).getUTCDay()) % 7;
      if (!days) return { kind: "clarify", reason: "menuRejected" };
      from = new Date(end + 86_400_000).toISOString().slice(0, 10);
      to = new Date(end + days * 86_400_000).toISOString().slice(0, 10);
    } else if (request.date) from = to = request.date;
    else if (correcting && action && "offer" in action.mutation.request) from = to = clinicDateAt(timeZone, new Date(action.mutation.request.offer.startsAt));
    else if (current && menu) { from = menu.from; to = menu.to; }
    else return denied;
    return kind === "booking" ? { kind: "bookingMenu", from, to, ...(request.kind === "window" ? { window: request.window } : {}) } :
      { kind: "reschedulingMenu", stage: "offers", from, to, ...(request.kind === "window" ? { window: request.window } : {}),
        ...(correcting ? { correcting: true as const } : {}) };
  }
}
