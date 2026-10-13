import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";
import type { MediaFrame } from "../voice/media-turn-controller.ts";
import type { ClinikoCallFlow } from "./cliniko-call-flow.ts";

/** One call's private transport boundary delegates only to its current workflow. */
export class PrivatePatientVoiceInput implements PrivateKeypadInput {
  readonly #owner: () => ClinikoCallFlow | undefined;
  readonly #defaultInput: PrivateKeypadInput;
  readonly #correction: PrivateKeypadInput;
  constructor(owner: () => ClinikoCallFlow | undefined, defaultInput: PrivateKeypadInput, correction: PrivateKeypadInput) {
    this.#owner = owner; this.#defaultInput = defaultInput; this.#correction = correction;
  }
  #active(): PrivateKeypadInput { return this.#owner()?.workflow === "patientUpdate" ? this.#correction : this.#defaultInput; }
  claim(callId: string, sessionId: string) { return this.#defaultInput.claim(callId, sessionId) && this.#correction.claim(callId, sessionId); }
  start() { return this.#defaultInput.start() && this.#correction.start(); }
  blocked() { return this.#active().blocked(); }
  accept(digit: string) { return this.#active().accept(digit); }
  acceptMedia(frame: MediaFrame) { return this.#active().acceptMedia?.(frame) ?? Promise.resolve("pending" as const); }
  stop(): void { this.#defaultInput.stop(); this.#correction.stop(); }
}
