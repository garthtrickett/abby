import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";
import type { MediaFrame } from "../voice/media-turn-controller.ts";
import type { ClinikoCallFlow } from "./cliniko-call-flow.ts";

type Config = Readonly<{ input: PrivateKeypadInput; owner: () => ClinikoCallFlow | undefined;
  present(text: string, signal: AbortSignal): Promise<boolean>; signal: AbortSignal }>;
type Stage = "verification" | "menu" | "choice" | "readback" | "return" | "ready" | "closed";

/** Appointment/recipient readbacks and OTP never enter ordinary transcription.
 * Private tasks run outside the wire event queue so playback marks can complete. */
export class PrivateResendVoiceInput implements PrivateKeypadInput {
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  readonly #onClose = () => this.stop();
  #stage: Stage = "verification";
  #count = 0;
  #hasNext = false;
  #hasPrevious = false;
  #working = false;
  #task: Promise<void> | undefined;
  constructor(config: Config) {
    this.#config = Object.freeze({ ...config }); config.signal.addEventListener("abort", this.#onClose, { once: true });
    if (config.signal.aborted) this.stop();
  }
  claim(callId: string, sessionId: string) { return this.#config.input.claim(callId, sessionId); }
  start() { return this.#stage !== "closed" && this.#config.input.start(); }
  blocked() {
    if (this.#stage === "closed") return true;
    return this.#config.owner()?.workflow === "confirmationResend" ? this.#stage !== "ready" || this.#config.input.blocked() : this.#config.input.blocked();
  }
  handlesDigit(digit: string) { return this.#config.input.handlesDigit?.(digit) === true; }
  #launch(run: (signal: AbortSignal) => Promise<void>) {
    if (this.#working || this.#stage === "closed") return;
    this.#working = true;
    const signal = AbortSignal.any([this.#lifetime.signal, this.#config.signal]);
    this.#task = run(signal).catch(() => this.stop()).finally(() => { this.#working = false; });
  }
  async accept(digit: string): Promise<"pending" | "verified" | "failed"> {
    const owner = this.#config.owner();
    if (this.#stage === "closed" || owner?.closed) return "failed";
    if (owner?.workflow !== "confirmationResend") return this.#config.input.accept(digit);
    if (this.#stage === "verification") {
      const answer = await this.#config.input.accept(digit);
      if (answer !== "verified") return answer;
      this.#stage = "menu";
      this.#launch(async signal => {
        const listed = await owner.listResendAppointments(signal);
        if (!listed.ok || !listed.value.count || signal.aborted) { this.stop(); return; }
        this.#count = listed.value.count; this.#hasNext = listed.value.hasNext; this.#hasPrevious = listed.value.hasPrevious; this.#stage = "choice";
      });
      return "pending";
    }
    if (digit === "*") { this.stop(); return "failed"; }
    // A playback receipt can precede the final native authority refresh. Keep a
    // post-play choice until that refresh completes; never retain an unplayed choice.
    if (this.#working && (this.#stage === "menu" || this.#stage === "choice") && /^[1-5]$/.test(digit) &&
        await owner.resendMenuPlaybackCompleted()) await this.#task;
    if (this.#lifetime.signal.aborted || owner.closed) return "failed";
    if (this.#working) return "pending";
    if (this.#stage === "choice" && (digit === "4" && this.#hasNext || digit === "5" && this.#hasPrevious)) {
      this.#stage = "menu";
      this.#launch(async signal => {
        const page = await owner.pageResendAppointments(digit === "4" ? "next" : "previous", signal);
        if (!page.ok || !page.value.count || signal.aborted) { this.stop(); return; }
        this.#count = page.value.count; this.#hasNext = page.value.hasNext; this.#hasPrevious = page.value.hasPrevious; this.#stage = "choice";
      });
    } else if (this.#stage === "choice" && /^[1-3]$/.test(digit) && Number(digit) <= this.#count) {
      this.#stage = "readback";
      this.#launch(async signal => {
        const selected = await owner.selectResendAppointment(Number(digit) as 1 | 2 | 3, signal);
        if (!selected.ok || signal.aborted) { this.stop(); return; }
        if (!await this.#config.present("Press pound to return to the call, then ask to send the appointment email. Sending requires a separate confirmation. Star stops this request.", signal)) { this.stop(); return; }
        this.#stage = "return";
      });
    } else if (this.#stage === "return" && digit === "#") {
      this.#stage = "ready"; return "verified";
    }
    return "pending";
  }
  acceptMedia(frame: MediaFrame) {
    if (this.#stage === "closed") return Promise.resolve("failed" as const);
    return this.#config.owner()?.workflow === "confirmationResend" ? Promise.resolve("pending" as const)
      : this.#config.input.acceptMedia?.(frame) ?? Promise.resolve("pending" as const);
  }
  stop() {
    if (this.#stage === "closed") return;
    this.#stage = "closed"; this.#count = 0; this.#lifetime.abort();
    this.#config.signal.removeEventListener("abort", this.#onClose); this.#config.input.stop();
  }
}
