import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";
import type { MediaFrame } from "../voice/media-turn-controller.ts";
import type { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import type { ClinikoFinancialBookingPreparation } from "./cliniko-financial-booking-preparation.ts";

type Ticket = Readonly<{ owner: ClinikoFinancialBookingPreparation; admission: ReturnType<ClinikoFinancialBookingPreparation["inputAdmission"]> }>;
/** The outer private fence discards financial speech and admits only a digit
 * observed after its exact quote/playback phase. Playback runs off the wire
 * semantic queue so that transport receipt marks can complete it. */
export class PrivateFinancialBookingInput implements PrivateKeypadInput {
  readonly #input: PrivateKeypadInput;
  readonly #owner: () => ClinikoCallFlow | undefined;
  readonly #tickets = new WeakMap<object, Ticket>();
  #task: Promise<unknown> | undefined;
  #closed = false;
  constructor(input: PrivateKeypadInput, owner: () => ClinikoCallFlow | undefined) { this.#input = input; this.#owner = owner; }
  claim(callId: string, sessionId: string) { return this.#input.claim(callId, sessionId); }
  start() { return !this.#closed && this.#input.start(); }
  blocked() { return this.#closed || this.#owner()?.financialBookingInput?.inputActive === true || this.#input.blocked(); }
  handlesDigit(digit: string) { return this.#input.handlesDigit?.(digit) === true; }
  captureDigit(digit: string, playbackPending: boolean): object | undefined {
    const owner = this.#owner()?.financialBookingInput;
    if (!owner?.inputActive) return this.#input.captureDigit?.(digit, playbackPending);
    const admission = !playbackPending && owner.inputAdmission();
    if (!admission || this.#closed) return undefined;
    const token = Object.freeze({}); this.#tickets.set(token, { owner, admission }); return token;
  }
  async accept(digit: string, arrival?: object): Promise<"pending" | "verified" | "failed"> {
    if (this.#closed) return "failed";
    const owner = this.#owner()?.financialBookingInput;
    if (!owner?.inputActive) return this.#input.accept(digit, arrival);
    const ticket = arrival && this.#tickets.get(arrival); if (arrival) this.#tickets.delete(arrival);
    if (!ticket || ticket.owner !== owner) return "pending";
    if (ticket.admission?.phase === "unplayed") {
      if (!this.#task) this.#task = owner.acceptDigit(digit, ticket.admission).catch(() => "pending").finally(() => { this.#task = undefined; });
      return "pending";
    }
    if (this.#task) await this.#task;
    return this.#closed ? "failed" : owner.acceptDigit(digit, ticket.admission);
  }
  acceptMedia(frame: MediaFrame) { return this.#owner()?.financialBookingInput?.inputActive ? Promise.resolve("pending" as const) : this.#input.acceptMedia?.(frame) ?? Promise.resolve("pending" as const); }
  stop() { this.#closed = true; this.#input.stop(); }
}
