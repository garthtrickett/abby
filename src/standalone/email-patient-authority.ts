import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { VerificationContact } from "../cliniko/verification-contact.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";
import { validCallerCandidates } from "../voice/caller-candidates.ts";
import { normalizeEmailAddress } from "../shared/email-address.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { PatientAuthority, PatientAuthorityDecision, PatientAuthorityRequest, PatientAuthorityRecheck, PatientOperation,
  VerificationPolicyGate } from "./transient-patient-proof.ts";
import { patientOperations } from "./transient-patient-proof.ts";

export interface PatientVerificationBudget {
  /** Shared clinic/account limit, never keyed by patient, email, phone, call or their hashes. */
  reserve(scope: LocationScope, kind: "issue" | "answer"): Promise<boolean>;
}
export interface PatientCodeDelivery {
  /** Fixed verification email, no appointment or patient facts. Success means transport acceptance only. */
  send(email: string, code: string, signal: AbortSignal): Promise<boolean>;
}
export interface PatientVerificationPermission {
  /** Trusted current patient/action authority policy, including self/proxy/minor restrictions.
   * Channel possession alone must not supply this decision. */
  allows(scope: LocationScope, patientId: string, operation: PatientOperation, policyVersion: string,
    signal: AbortSignal): Promise<boolean>;
}
type Config = Readonly<{
  scope: LocationScope; callId: string; sessionId: string; policyVersion: string;
  presentedNumber: string; operations: readonly PatientOperation[];
  lookup: CallerCandidateLookup; contact: VerificationContact; policy: VerificationPolicyGate;
  permission: PatientVerificationPermission;
  budget: PatientVerificationBudget; delivery: PatientCodeDelivery;
  clock?: () => number; deadlineMs?: number;
}>;
type Challenge = Readonly<{ patientId: string; email: string; salt: string; digest: Buffer;
  operation: PatientOperation; expiresAt: number }>;
type Grant = Readonly<{ token: string; challenge: Challenge }>;
type Denied = Readonly<{ kind: "denied" }>;
const allowedOperations: readonly PatientOperation[] = patientOperations;
const codeDigest = (salt: string, code: string): Buffer => createHash("sha256").update(`${salt}\0${code}`).digest();

async function untilAbort<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value | undefined> {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined); signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) resolve(undefined);
  });
  try { return await Promise.race([pending, aborted]); } catch { return undefined; }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** One live call owns its challenge and single-use attestation token. No persistence or model port. */
export class EmailPatientAuthority implements PatientAuthority {
  readonly #config: Config;
  readonly #lifetime = new AbortController();
  #started = false;
  #busy = false;
  #answers = 0;
  #challenge: Challenge | undefined;
  #attested: Pick<Challenge, "patientId" | "email" | "operation" | "expiresAt"> | undefined;
  #grant: Grant | undefined;
  constructor(config: Config) {
    if (!config.scope || ![config.scope.tenantId, config.scope.clinicId, config.scope.locationId,
      config.callId, config.sessionId, config.policyVersion].every(value => typeof value === "string" &&
        !!value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) ||
      !/^\+[1-9][0-9]{7,14}$/.test(config.presentedNumber) || !Array.isArray(config.operations) ||
      !config.operations.length || config.operations.length > 4 || new Set(config.operations).size !== config.operations.length ||
      config.operations.some(operation => !allowedOperations.includes(operation)) ||
      (config.deadlineMs !== undefined && (!Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < 1 || config.deadlineMs > 20_000)) ||
      (config.clock !== undefined && typeof config.clock !== "function") ||
      typeof config.lookup?.candidates !== "function" || typeof config.contact?.read !== "function" ||
      typeof config.policy?.current !== "function" || typeof config.budget?.reserve !== "function" ||
      typeof config.permission?.allows !== "function" ||
      typeof config.delivery?.send !== "function") throw new TypeError("invalid email patient authority configuration");
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }), operations: Object.freeze([...config.operations]) });
  }

  #now(): number {
    const now = (this.#config.clock ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 300_000) throw new Error("verification clock unavailable");
    return now;
  }
  async #current(operation: PatientOperation, patientId?: string, email?: string, signal = this.#lifetime.signal): Promise<Readonly<{ patientId: string; email: string }> | undefined> {
    const config = this.#config;
    if (signal.aborted) return undefined;
    const policy = await config.policy.current(config.scope);
    if (!policy.ok || policy.value.enabled !== true || policy.value.version !== config.policyVersion ||
        !sameScope(policy.value.scope, config.scope) || signal.aborted) return undefined;
    const candidates = await config.lookup.candidates(config.scope, config.presentedNumber);
    if (!candidates.ok || !validCallerCandidates(candidates.value) || candidates.value.kind !== "one" || candidates.value.candidateIds.length !== 1 ||
        signal.aborted) return undefined;
    const selected = candidates.value.candidateIds[0]!;
    if (!/^[1-9][0-9]{0,18}$/.test(selected) || (patientId !== undefined && patientId !== selected)) return undefined;
    const contact = await config.contact.read(config.scope, selected, config.presentedNumber, signal);
    if (!contact.ok || typeof contact.value !== "string" || normalizeEmailAddress(contact.value) !== contact.value ||
        (email !== undefined && email !== contact.value) || signal.aborted) return undefined;
    if (await config.permission.allows(config.scope, selected, operation, config.policyVersion, signal) !== true || signal.aborted) return undefined;
    const finalPolicy = await config.policy.current(config.scope);
    return finalPolicy.ok && finalPolicy.value.enabled === true && finalPolicy.value.version === config.policyVersion &&
      sameScope(finalPolicy.value.scope, config.scope) && !signal.aborted ? { patientId: selected, email: contact.value } : undefined;
  }

  async #bounded<Value>(run: (signal: AbortSignal) => Promise<Value>, external?: AbortSignal): Promise<Value | undefined> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(external ? [external] : [])]);
    const timer = setTimeout(() => controller.abort(), this.#config.deadlineMs ?? 5_000);
    try { return await untilAbort(Promise.resolve().then(() => run(signal)), signal); }
    finally { controller.abort(); clearTimeout(timer); }
  }

  /** Fixed result: never disclose whether a patient/address exists, nor promise mailbox delivery. */
  async start(operation: PatientOperation): Promise<void> {
    if (this.#started || this.#busy || this.#lifetime.signal.aborted) return;
    this.#started = true; this.#busy = true;
    try {
      const challenge = await this.#bounded(async signal => {
        if (!this.#config.operations.includes(operation) || !await this.#config.budget.reserve(this.#config.scope, "issue") || signal.aborted) return undefined;
        const contact = await this.#current(operation, undefined, undefined, signal);
        if (!contact || signal.aborted) return undefined;
        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
        const salt = randomBytes(32).toString("base64url");
        const value: Challenge = { ...contact, salt, digest: codeDigest(salt, code), operation, expiresAt: this.#now() + 300_000 };
        const delivered = await this.#config.delivery.send(contact.email, code, signal);
        return delivered === true && !signal.aborted ? value : undefined;
      });
      if (!this.#lifetime.signal.aborted) this.#challenge = challenge;
    } finally { this.#busy = false; }
  }

  /** Called by the trusted text/keypad owner, outside model context. All failures share one denial. */
  async answer(code: string): Promise<Result<string, Denied>> {
    if (this.#busy || this.#lifetime.signal.aborted || this.#grant || this.#answers >= 3) return err({ kind: "denied" });
    this.#busy = true; this.#answers += 1;
    try {
      const grant = await this.#bounded(async signal => {
        if (!await this.#config.budget.reserve(this.#config.scope, "answer") || signal.aborted) return undefined;
        const challenge = this.#challenge;
        if (!challenge || this.#now() >= challenge.expiresAt || !/^[0-9]{6}$/.test(code) ||
            !timingSafeEqual(challenge.digest, codeDigest(challenge.salt, code))) return undefined;
        const current = await this.#current(challenge.operation, challenge.patientId, challenge.email, signal);
        if (!current || this.#now() >= challenge.expiresAt || signal.aborted) return undefined;
        return { token: randomBytes(32).toString("base64url"), challenge };
      });
      if (!grant || this.#lifetime.signal.aborted) {
        if (this.#answers >= 3) this.#challenge = undefined;
        return err({ kind: "denied" });
      }
      this.#challenge = undefined; this.#grant = grant; return ok(grant.token);
    } finally { this.#busy = false; }
  }

  async attest(request: PatientAuthorityRequest): Promise<Result<PatientAuthorityDecision, Denied>> {
    if (this.#busy || this.#lifetime.signal.aborted || request.signal.aborted || !this.#grant ||
        !sameScope(request.scope, this.#config.scope) || request.callId !== this.#config.callId ||
        request.sessionId !== this.#config.sessionId || request.policyVersion !== this.#config.policyVersion ||
        request.operation !== this.#grant.challenge.operation || request.token !== this.#grant.token ||
        request.candidateIds.length !== 1 || request.candidateIds[0] !== this.#grant.challenge.patientId) return err({ kind: "denied" });
    const grant = this.#grant; this.#grant = undefined; this.#busy = true;
    try {
      const current = await this.#bounded(async signal => {
        if (this.#now() >= grant.challenge.expiresAt) return undefined;
        const contact = await this.#current(grant.challenge.operation, grant.challenge.patientId, grant.challenge.email, signal);
        return this.#now() < grant.challenge.expiresAt ? contact : undefined;
      }, request.signal);
      if (!current || this.#lifetime.signal.aborted || request.signal.aborted) return err({ kind: "denied" });
      this.#attested = { patientId: current.patientId, email: current.email, operation: grant.challenge.operation, expiresAt: grant.challenge.expiresAt };
      return ok({ scope: this.#config.scope, callId: this.#config.callId, sessionId: this.#config.sessionId,
        policyVersion: this.#config.policyVersion, patientId: current.patientId, operations: [grant.challenge.operation] });
    } finally { this.#busy = false; }
  }

  async revalidate(request: PatientAuthorityRecheck): Promise<boolean> {
    const attested = this.#attested, config = this.#config;
    if (this.#busy || this.#lifetime.signal.aborted || request.signal.aborted || !attested ||
        !sameScope(request.scope, config.scope) || request.callId !== config.callId || request.sessionId !== config.sessionId ||
        request.patientId !== attested.patientId || request.operation !== attested.operation || request.policyVersion !== config.policyVersion) return false;
    this.#busy = true;
    try {
      const current = await this.#bounded(async signal => {
        if (this.#now() >= attested.expiresAt) return undefined;
        const fresh = await this.#current(attested.operation, attested.patientId, attested.email, signal);
        return this.#now() < attested.expiresAt ? fresh : undefined;
      }, request.signal);
      if (!current || request.signal.aborted || this.#lifetime.signal.aborted || this.#attested !== attested) {
        if (this.#attested === attested) this.#attested = undefined;
        return false;
      }
      return true;
    } finally { this.#busy = false; }
  }

  close(): void { this.#lifetime.abort(); this.#challenge = undefined; this.#grant = undefined; this.#attested = undefined; }
}
