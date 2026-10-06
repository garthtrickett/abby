import type { PrivateKeypadInput } from "../voice/private-keypad-input.ts";
import { ClinikoCallFlow } from "./cliniko-call-flow.ts";

type Config = Readonly<{ callId: string; sessionId: string; owner: () => ClinikoCallFlow | undefined }>;

/** The initial spoken request selects a workflow. Once its verifier is selected, all
 * media and keypad traffic use the transport's private-input fence until verification.
 * A code or a proof is never exposed by this interface. */
export class PrivateWorkflowKeypad implements PrivateKeypadInput {
  readonly #config: Config;
  #claimed = false;
  #started = false;
  #closed = false;
  #owner: ClinikoCallFlow | undefined;
  #digits = "";
  #overflow = false;
  #busy = false;
  #attempts = 0;
  constructor(config: Config) {
    if (![config.callId, config.sessionId].every(value => typeof value === "string" && !!value.trim() && value.length <= 256) ||
        typeof config.owner !== "function") throw new TypeError("invalid private workflow input");
    this.#config = Object.freeze({ ...config });
  }
  claim(callId: string, sessionId: string): boolean {
    if (this.#claimed || this.#closed || callId !== this.#config.callId || sessionId !== this.#config.sessionId) return false;
    this.#claimed = true; return true;
  }
  start(): boolean {
    if (!this.#claimed || this.#closed || this.#started) return false;
    try {
      const owner = this.#config.owner(), binding = owner?.binding();
      if (!(owner instanceof ClinikoCallFlow) || owner.closed || binding?.callId !== this.#config.callId || binding.sessionId !== this.#config.sessionId) return false;
      this.#owner = owner; this.#started = true; return true;
    } catch { this.stop(); return false; }
  }
  blocked(): boolean {
    if (this.#closed || !this.#started) return true;
    if (this.#config.owner() !== this.#owner || this.#owner!.closed) { this.stop(); return true; }
    return this.#owner!.verificationRequired;
  }
  async accept(digit: string): Promise<"pending" | "verified" | "failed"> {
    if (this.#closed || !this.#started || this.#config.owner() !== this.#owner || this.#owner!.closed) { this.stop(); return "failed"; }
    if (this.#busy || !this.#owner!.verificationRequired) return "pending";
    if (digit === "*") { this.#digits = ""; this.#overflow = false; return "pending"; }
    if (/^[0-9]$/.test(digit)) {
      if (this.#digits.length < 6) this.#digits += digit; else this.#overflow = true;
      return "pending";
    }
    if (digit !== "#") { this.#overflow = true; return "pending"; }
    const code = !this.#overflow && this.#digits.length === 6 ? this.#digits : "";
    this.#digits = ""; this.#overflow = false; this.#busy = true; this.#attempts++;
    try {
      const answer = await this.#owner!.submitCode(code);
      if (this.#closed || this.#config.owner() !== this.#owner) { this.stop(); return "failed"; }
      if (this.#owner!.patientAccessDenied) return "pending";
      if (answer.verified) return "verified";
      if (this.#attempts >= 3) { this.stop(); return "failed"; }
      return "pending";
    } catch { this.stop(); return "failed"; }
    finally { this.#busy = false; }
  }
  stop(): void {
    this.#closed = true; this.#digits = ""; this.#overflow = false;
    this.#owner?.dispose(); this.#owner = undefined;
  }
}
