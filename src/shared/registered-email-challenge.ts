import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { normalizeEmailAddress } from "./email-address.ts";
import { awaitUntilAbort } from "./await-until-abort.ts";

export interface VerificationCodeBudget {
  /** Shared clinic/account limit; never keyed by a private identity or its hash. */
  reserve(scope: LocationScope, kind: "issue" | "answer"): Promise<boolean>;
}
export interface VerificationCodeDelivery {
  /** Fixed verification message only. Transport acceptance does not prove delivery. */
  send(email: string, code: string, signal: AbortSignal): Promise<boolean>;
}
type Snapshot = Readonly<{ registeredEmail: string }>;
type Denied = Readonly<{ kind: "denied" }>;
type Config<Identity extends Snapshot, Context extends string> = Readonly<{
  scope: LocationScope; contexts: readonly Context[]; budget: VerificationCodeBudget; delivery: VerificationCodeDelivery;
  /** Owns identity/channel/permission checks, including their final current-state check.
   * One invocation performs one owning validation transaction. */
  current(context: Context, expected: Identity | undefined, signal: AbortSignal): Promise<Identity | undefined>;
  clock?: () => number; deadlineMs?: number; expiryCeiling?: (snapshot: Identity) => number;
}>;
type Challenge<Identity, Context> = Readonly<{ snapshot: Identity; context: Context; salt: string; digest: Buffer; expiresAt: number }>;
type Attested<Identity, Context> = Readonly<{ snapshot: Identity; context: Context; expiresAt: number }>;
const denied = (): Result<never, Denied> => err({ kind: "denied" });
const digest = (salt: string, code: string): Buffer => createHash("sha256").update(`${salt}\0${code}`).digest();

/** Private one-call code lifecycle. This module proves possession of the exact
 * currently approved channel; callers separately own actor and patient authority. */
export class RegisteredEmailChallenge<Identity extends Snapshot, Context extends string> {
  readonly #config: Config<Identity, Context>;
  readonly #lifetime = new AbortController();
  #started = false;
  #busy = false;
  #answers = 0;
  #challenge: Challenge<Identity, Context> | undefined;
  #grant: Readonly<{ token: string; challenge: Challenge<Identity, Context> }> | undefined;
  #attested: Attested<Identity, Context> | undefined;
  constructor(incoming: Config<Identity, Context>) {
    if (!incoming?.scope || ![incoming.scope.tenantId, incoming.scope.clinicId, incoming.scope.locationId].every(value =>
      typeof value === "string" && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) ||
      !Array.isArray(incoming.contexts) || !incoming.contexts.length || incoming.contexts.length > 4 ||
      new Set(incoming.contexts).size !== incoming.contexts.length || incoming.contexts.some(value => typeof value !== "string" || !value || value.length > 128) ||
      typeof incoming.current !== "function" || typeof incoming.budget?.reserve !== "function" || typeof incoming.delivery?.send !== "function" ||
      incoming.clock !== undefined && typeof incoming.clock !== "function" || incoming.expiryCeiling !== undefined && typeof incoming.expiryCeiling !== "function" ||
      incoming.deadlineMs !== undefined && (!Number.isSafeInteger(incoming.deadlineMs) || incoming.deadlineMs < 1 || incoming.deadlineMs > 20_000))
      throw new TypeError("invalid registered email challenge configuration");
    this.#config = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }), contexts: Object.freeze([...incoming.contexts]) });
  }
  #now(): number {
    const now = (this.#config.clock ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 300_000) throw new Error("verification clock unavailable");
    return now;
  }
  async #bounded<Value>(run: (signal: AbortSignal) => Promise<Value>, external?: AbortSignal): Promise<Value | undefined> {
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(external ? [external] : [])]);
    const timer = setTimeout(() => controller.abort(), this.#config.deadlineMs ?? 5_000);
    try { return await awaitUntilAbort(Promise.resolve().then(() => run(signal)), signal); }
    catch { return undefined; }
    finally { controller.abort(); clearTimeout(timer); }
  }
  async #current(context: Context, expected: Identity | undefined, signal: AbortSignal): Promise<Identity | undefined> {
    if (signal.aborted) return undefined;
    const value = await this.#config.current(context, expected ? structuredClone(expected) : undefined, signal);
    if (!value || signal.aborted || typeof value.registeredEmail !== "string" || normalizeEmailAddress(value.registeredEmail) !== value.registeredEmail ||
        expected && !isDeepStrictEqual(value, expected)) return undefined;
    return structuredClone(value);
  }
  #accepts(predicate: (snapshot: Identity) => boolean, snapshot: Identity): boolean {
    try { return predicate(structuredClone(snapshot)) === true; } catch { return false; }
  }
  async start(context: Context): Promise<void> {
    if (this.#started || this.#busy || this.#lifetime.signal.aborted) return;
    this.#started = true; this.#busy = true;
    try {
      const challenge = await this.#bounded(async signal => {
        if (!this.#config.contexts.includes(context) || !await this.#config.budget.reserve(this.#config.scope, "issue") || signal.aborted) return undefined;
        const snapshot = await this.#current(context, undefined, signal); if (!snapshot || signal.aborted) return undefined;
        const now = this.#now(), ceiling = this.#config.expiryCeiling?.(structuredClone(snapshot)) ?? now + 300_000;
        if (!Number.isSafeInteger(ceiling) || ceiling <= now) return undefined;
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0"), salt = randomBytes(32).toString("base64url");
        const value: Challenge<Identity, Context> = { snapshot, context, salt, digest: digest(salt, code), expiresAt: Math.min(now + 300_000, ceiling) };
        return await this.#config.delivery.send(snapshot.registeredEmail, code, signal) === true && !signal.aborted ? value : undefined;
      });
      if (!this.#lifetime.signal.aborted) this.#challenge = challenge;
    } finally { this.#busy = false; }
  }
  async answer(code: string): Promise<Result<string, Denied>> {
    if (this.#busy || this.#lifetime.signal.aborted || this.#grant || this.#answers >= 3) return denied();
    this.#busy = true; this.#answers++;
    try {
      const grant = await this.#bounded(async signal => {
        if (!await this.#config.budget.reserve(this.#config.scope, "answer") || signal.aborted) return undefined;
        const challenge = this.#challenge;
        if (!challenge || this.#now() >= challenge.expiresAt || typeof code !== "string" || !/^[0-9]{6}$/.test(code) ||
            !timingSafeEqual(challenge.digest, digest(challenge.salt, code))) return undefined;
        const current = await this.#current(challenge.context, challenge.snapshot, signal);
        return current && this.#now() < challenge.expiresAt && !signal.aborted ? { token: randomBytes(32).toString("base64url"), challenge } : undefined;
      });
      if (!grant || this.#lifetime.signal.aborted) { if (this.#answers >= 3) this.#challenge = undefined; return denied(); }
      this.#challenge = undefined; this.#grant = grant; return ok(grant.token);
    } finally { this.#busy = false; }
  }
  async consume(request: Readonly<{ token: string; context: Context; accepts: (snapshot: Identity) => boolean; signal: AbortSignal }>):
    Promise<Result<Attested<Identity, Context>, Denied>> {
    if (this.#busy || this.#lifetime.signal.aborted || request.signal.aborted || !this.#grant || request.token !== this.#grant.token ||
        request.context !== this.#grant.challenge.context || !this.#accepts(request.accepts, this.#grant.challenge.snapshot)) return denied();
    const grant = this.#grant; this.#grant = undefined; this.#busy = true;
    try {
      const current = await this.#bounded(async signal => {
        if (this.#now() >= grant.challenge.expiresAt) return undefined;
        const snapshot = await this.#current(grant.challenge.context, grant.challenge.snapshot, signal);
        return this.#now() < grant.challenge.expiresAt ? snapshot : undefined;
      }, request.signal);
      if (!current || this.#lifetime.signal.aborted || request.signal.aborted) return denied();
      this.#attested = { snapshot: current, context: grant.challenge.context, expiresAt: grant.challenge.expiresAt };
      return ok(structuredClone(this.#attested));
    } finally { this.#busy = false; }
  }
  async revalidate(context: Context, accepts: (snapshot: Identity) => boolean, signal: AbortSignal): Promise<boolean> {
    const attested = this.#attested;
    if (this.#busy || this.#lifetime.signal.aborted || signal.aborted || !attested || context !== attested.context || !this.#accepts(accepts, attested.snapshot)) return false;
    this.#busy = true;
    try {
      const current = await this.#bounded(async bound => {
        if (this.#now() >= attested.expiresAt) return undefined;
        const snapshot = await this.#current(attested.context, attested.snapshot, bound);
        return this.#now() < attested.expiresAt ? snapshot : undefined;
      }, signal);
      if (!current || signal.aborted || this.#lifetime.signal.aborted || this.#attested !== attested) {
        if (this.#attested === attested) this.#attested = undefined;
        return false;
      }
      return true;
    } finally { this.#busy = false; }
  }
  close(): void { this.#lifetime.abort(); this.#challenge = undefined; this.#grant = undefined; this.#attested = undefined; }
}
