import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";
import { CallerVerificationSession } from "./caller-verification-session.ts";

type Config = Readonly<{ callId: string; sessionId: string; owner: () => CallerVerificationSession | undefined }>;
/** Six digits then #; * clears the current entry. No digit, code or proof appears in progress. */
export class PrivateKeypadVerification implements PrivateKeypadInput {
  readonly #config: Config;
  #claimed = false;
  #closed = false;
  #verified = false;
  #busy = false;
  #digits = "";
  #overflow = false;
  #attempts = 0;
  #owner: CallerVerificationSession | undefined;
  constructor(config: Config) {
    if (![config.callId, config.sessionId].every(value => typeof value === "string" && !!value.trim() && value.length <= 256) ||
        typeof config.owner !== "function") throw new TypeError("invalid private keypad configuration");
    this.#config = Object.freeze({ ...config });
  }
  claim(callId: string, sessionId: string): boolean {
    if (this.#claimed || this.#closed || callId !== this.#config.callId || sessionId !== this.#config.sessionId) return false;
    this.#claimed = true; return true;
  }
  start(): boolean {
    if (!this.#claimed || this.#closed || this.#owner) return false;
    try {
      const owner = this.#config.owner();
      if (!(owner instanceof CallerVerificationSession)) return false;
      const binding = owner.binding();
      if (binding.callId !== this.#config.callId || binding.sessionId !== this.#config.sessionId) return false;
      this.#owner = owner; owner.begin(); return true;
    } catch { this.stop(); return false; }
  }
  blocked(): boolean { return !this.#verified || this.#closed; }
  async accept(digit: string): Promise<"pending" | "verified" | "failed"> {
    if (!this.#claimed || this.#closed || !this.#owner) return "failed";
    if (this.#busy || this.#verified) return "pending";
    try {
      const owner = this.#config.owner();
      if (!(owner instanceof CallerVerificationSession)) { this.stop(); return "failed"; }
      const bound = owner.binding();
      if (bound.callId !== this.#config.callId || bound.sessionId !== this.#config.sessionId || (this.#owner && this.#owner !== owner)) {
        this.stop(); return "failed";
      }
      if (digit === "*") { this.#digits = ""; this.#overflow = false; return "pending"; }
      if (/^[0-9]$/.test(digit)) {
        if (this.#digits.length < 6) this.#digits += digit;
        else this.#overflow = true;
        return "pending";
      }
      if (digit !== "#") { this.#overflow = true; return "pending"; }
      const code = !this.#overflow && this.#digits.length === 6 ? this.#digits : "";
      this.#digits = ""; this.#overflow = false; this.#attempts += 1; this.#busy = true;
      const answer = await owner.submitCode(code);
      if (this.#closed) return "failed";
      if (answer.verified === true) { this.#verified = true; return "verified"; }
      if (this.#attempts >= 3) { this.stop(); return "failed"; }
      return "pending";
    } catch { this.stop(); return "failed"; }
    finally { this.#busy = false; }
  }
  stop(): void {
    this.#closed = true; this.#verified = false; this.#digits = ""; this.#overflow = false;
    this.#owner?.dispose(); this.#owner = undefined;
  }
}
