import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { LocationScope } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import type { PatientCodeDelivery, PatientVerificationBudget } from "./email-patient-authority.ts";

type Config = Readonly<{ scope: LocationScope; budget: PatientVerificationBudget; delivery: PatientCodeDelivery;
  current: (signal: AbortSignal) => Promise<boolean>; clock: () => number; timeoutMs: number }>;
type Challenge = Readonly<{ email: string; salt: string; digest: Buffer; expiresAt: number }>;
const digest = (salt: string, code: string) => createHash("sha256").update(`${salt}\0${code}`).digest();

/** Mailbox possession for one prospective draft only. It supplies no patient identity or operation permission. */
export class ProspectiveEmailCode {
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  #started = false;
  #busy = false;
  #answers = 0;
  #challenge: Challenge | undefined;
  #verified: Pick<Challenge, "email" | "expiresAt"> | undefined;
  constructor(config: Config) {
    if (!config.scope || typeof config.budget?.reserve !== "function" || typeof config.delivery?.send !== "function" ||
        typeof config.current !== "function" || typeof config.clock !== "function" ||
        !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30_000) throw new TypeError("invalid prospective email configuration");
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
  }
  #now(): number {
    const now = this.#config.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 300_000) throw new Error("mailbox clock unavailable");
    return now;
  }
  async #bounded<T>(run: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T | undefined> {
    const deadline = AbortSignal.timeout(this.#config.timeoutMs);
    const signal = AbortSignal.any([deadline, this.#lifetime.signal, ...(external ? [external] : [])]);
    try { return await awaitUntilAbort(Promise.resolve().then(() => signal.aborted ? undefined : run(signal)), signal); }
    catch { return undefined; }
  }
  /** Uniform result; transport acceptance is not mailbox delivery. No resend on this instance. */
  async start(email: string, signal?: AbortSignal): Promise<void> {
    if (this.#started || this.#busy || this.#lifetime.signal.aborted) return;
    this.#started = true; this.#busy = true;
    try {
      const challenge = await this.#bounded(async stop => {
        const normalized = normalizeEmailAddress(email);
        if (!normalized || !await this.#config.budget.reserve(this.#config.scope, "issue") || stop.aborted ||
            !await this.#config.current(stop) || stop.aborted) return undefined;
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0"), salt = randomBytes(32).toString("base64url");
        const value = { email: normalized, salt, digest: digest(salt, code), expiresAt: this.#now() + 300_000 };
        const accepted = await this.#config.delivery.send(normalized, code, stop);
        return accepted === true && !stop.aborted && this.#now() < value.expiresAt && await this.#config.current(stop) && !stop.aborted ? value : undefined;
      }, signal);
      if (!this.#lifetime.signal.aborted) this.#challenge = challenge;
    } finally { this.#busy = false; }
  }
  /** Trusted secret input; the code never enters a caller turn, agent command or proof result. */
  async answer(code: string, external?: AbortSignal): Promise<boolean> {
    if (this.#busy || this.#lifetime.signal.aborted || this.#verified || this.#answers >= 3) return false;
    this.#busy = true; ++this.#answers;
    try {
      const result = await this.#bounded(async signal => {
        const challenge = this.#challenge;
        if (!await this.#config.budget.reserve(this.#config.scope, "answer") || signal.aborted || !challenge ||
            this.#now() >= challenge.expiresAt || typeof code !== "string" || !/^[0-9]{6}$/.test(code) ||
            !timingSafeEqual(challenge.digest, digest(challenge.salt, code)) || !await this.#config.current(signal) ||
            signal.aborted || this.#now() >= challenge.expiresAt) return undefined;
        return { email: challenge.email, expiresAt: challenge.expiresAt };
      }, external);
      if (!result || this.#lifetime.signal.aborted) { if (this.#answers >= 3) this.close(); return false; }
      this.#verified = result; this.#challenge = undefined; return true;
    } finally { this.#busy = false; }
  }
  verified(email: string): boolean {
    try { return !this.#lifetime.signal.aborted && !!this.#verified && this.#verified.email === normalizeEmailAddress(email) && this.#now() < this.#verified.expiresAt; }
    catch { return false; }
  }
  expiresAt(): string | undefined {
    return this.#verified ? new Date(this.#verified.expiresAt).toISOString() : undefined;
  }
  close(): void { this.#lifetime.abort(); this.#challenge = undefined; this.#verified = undefined; }
}
