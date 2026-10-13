import { randomBytes } from "node:crypto";
import type { HostReadFailure, PatientProofHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, VerifiedPatient } from "../core/model.ts";
import { validCallerCandidates } from "../voice/caller-candidates.ts";
import type { CallerCandidateLookup } from "../voice/caller-candidates.ts";

export const patientOperations = Object.freeze(["appointments.read", "appointments.book", "appointments.cancel", "appointments.reschedule", "staff.request", "patients.update"] as const);
export type PatientOperation = typeof patientOperations[number];
export type VerificationFailure = Readonly<{ kind: "disabled" | "denied" | "unavailable" | "attemptsExhausted" | "disconnected" }>;
export type VerificationToken = string;
export type PatientAuthorityRequest = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  candidateIds: readonly string[];
  token: VerificationToken;
  operation: PatientOperation;
  policyVersion: string;
  signal: AbortSignal;
}>;
export type PatientAuthorityRecheck = Omit<PatientAuthorityRequest, "token" | "candidateIds"> & Readonly<{ patientId: string }>;
export type PatientAuthorityDecision = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  patientId: string;
  operations: readonly PatientOperation[];
  /** Original source expiry; issuance must never extend it. */
  expiresAt?: string;
  policyVersion: string;
}>;
export type PatientAuthority = Readonly<{
  /** Sources with mutable contact/action permission recheck every protected use. No new proof is issued. */
  revalidate?(request: PatientAuthorityRecheck): Promise<boolean>;
  /** The trusted verifier resolves a call-bound host token; no spoken answer or model output is accepted here. */
  attest(request: PatientAuthorityRequest): Promise<Result<PatientAuthorityDecision,
    Readonly<{ kind: "denied" | "unavailable" }>>>;
}>;
export type VerificationPolicyGate = Readonly<{
  current(scope: LocationScope): Promise<Result<Readonly<{ scope: LocationScope; enabled: boolean; version: string }>,
    Readonly<{ kind: "unavailable" }>>>;
}>;
export type TransientPatientProofConfig = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  /** Obtained from the authenticated inbound call, never from a model turn. */
  presentedCallerNumber: string | undefined;
  policyVersion: string;
  maxAttempts: 1 | 2 | 3;
  lookup: CallerCandidateLookup;
  authority: PatientAuthority;
  policy: VerificationPolicyGate;
  clock?: () => string;
  /** Whole-attempt deadline, including lookup, attestation, and the fresh recheck. */
  timeoutMs?: number;
}>;

type LiveProof = Readonly<{
  patientId: string;
  verificationRef: string;
  operations: readonly PatientOperation[];
  expiresAt: string;
}>;
const operations: readonly PatientOperation[] = patientOperations;
const maxProofMs = 5 * 60_000;

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function validScope(scope: unknown): scope is LocationScope {
  if (typeof scope !== "object" || scope === null) return false;
  const value = scope as Record<string, unknown>;
  return [value.tenantId, value.clinicId, value.locationId]
    .every(part => typeof part === "string" && part.trim().length > 0 && part.length <= 256);
}

function validRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** One active call owns one volatile proof. This class has no persistence or live runner activation path. */
export class TransientPatientProofHost implements PatientProofHost {
  readonly #scope: LocationScope;
  readonly #callId: string;
  readonly #sessionId: string;
  #presentedNumber: string | undefined;
  readonly #policyVersion: string;
  readonly #maxAttempts: number;
  readonly #lookup: CallerCandidateLookup;
  readonly #authority: PatientAuthority;
  readonly #policy: VerificationPolicyGate;
  readonly #clock: () => string;
  readonly #timeoutMs: number;
  #attempts = 0;
  #busy = false;
  #closed = false;
  #epoch = 0;
  #attemptAbort: AbortController | undefined;
  #proof: LiveProof | undefined;
  readonly #refreshes = new Set<AbortController>();

  constructor(config: TransientPatientProofConfig) {
    if (!validScope(config.scope) ||
      !validRef(config.callId) || !validRef(config.sessionId) ||
      typeof config.policyVersion !== "string" || !config.policyVersion.trim() || config.policyVersion.length > 256 ||
      ![1, 2, 3].includes(config.maxAttempts) || !config.lookup || typeof config.lookup.candidates !== "function" ||
      !config.authority || typeof config.authority.attest !== "function" ||
      (config.authority.revalidate !== undefined && typeof config.authority.revalidate !== "function") ||
      !config.policy || typeof config.policy.current !== "function" ||
      (config.clock !== undefined && typeof config.clock !== "function") ||
      (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 1 || config.timeoutMs > 30_000))) throw new TypeError("invalid patient proof configuration");
    this.#scope = Object.freeze(structuredClone(config.scope));
    this.#callId = config.callId;
    this.#sessionId = config.sessionId;
    this.#presentedNumber = config.presentedCallerNumber;
    this.#policyVersion = config.policyVersion;
    this.#maxAttempts = config.maxAttempts;
    this.#lookup = config.lookup;
    this.#authority = config.authority;
    this.#policy = config.policy;
    this.#clock = config.clock ?? (() => new Date().toISOString());
    this.#timeoutMs = config.timeoutMs ?? 20_000;
  }

  /** Trusted compositions cannot reuse this verifier for another call, session or captured policy. */
  matchesCall(scope: LocationScope, callId: string, sessionId: string, policyVersion: string): boolean {
    return !this.#closed && validScope(scope) && sameScope(scope, this.#scope) && callId === this.#callId &&
      sessionId === this.#sessionId && policyVersion === this.#policyVersion;
  }

  async #enabled(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const pending = this.#policy.current(this.#scope);
      const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), this.#timeoutMs); });
      const state = await Promise.race([pending, timeout]);
      return !!state && state.ok && validScope(state.value.scope) && sameScope(state.value.scope, this.#scope) &&
        state.value.enabled === true && state.value.version === this.#policyVersion;
    } catch { return false; }
    finally { if (timer) clearTimeout(timer); }
  }

  async #candidates(): Promise<readonly string[] | undefined> {
    if (typeof this.#presentedNumber !== "string" || !this.#presentedNumber || this.#presentedNumber.length > 64) return undefined;
    try {
      const found = await this.#lookup.candidates(this.#scope, this.#presentedNumber);
      if (!found.ok || !validCallerCandidates(found.value) ||
          (found.value.kind !== "one" && found.value.kind !== "multiple") ||
          found.value.candidateIds.some(id => !/^[1-9][0-9]*$/.test(id))) return undefined;
      return Object.freeze([...found.value.candidateIds]);
    } catch { return undefined; }
  }

  /** Called only by the trusted call owner after an independent verifier has issued a token. */
  async issue(token: VerificationToken, operation: PatientOperation): Promise<Result<Readonly<{
    verificationRef: string; expiresAt: string;
  }>, VerificationFailure>> {
    if (this.#closed) return err({ kind: "disconnected" });
    if (this.#busy || this.#proof) return err({ kind: "denied" });
    if (this.#attempts >= this.#maxAttempts) return err({ kind: "attemptsExhausted" });
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(token) || !operations.includes(operation)) return err({ kind: "denied" });
    this.#busy = true;
    this.#attempts += 1;
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#attemptAbort = controller;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<Result<Readonly<{ verificationRef: string; expiresAt: string }>, VerificationFailure>>(resolve => {
        timer = setTimeout(() => { this.revoke(); resolve(err({ kind: this.#closed ? "disconnected" : "unavailable" })); }, this.#timeoutMs);
      });
      return await Promise.race([this.#performIssue(token, operation, epoch, controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.#attemptAbort === controller) this.#attemptAbort = undefined;
      this.#busy = false;
    }
  }

  async #performIssue(token: VerificationToken, operation: PatientOperation, epoch: number,
                      signal: AbortSignal): Promise<Result<Readonly<{
    verificationRef: string; expiresAt: string;
  }>, VerificationFailure>> {
    try {
      if (!await this.#enabled()) return err({ kind: "disabled" });
      if (this.#closed || this.#epoch !== epoch) return err({ kind: "disconnected" });
      const first = await this.#candidates();
      if (!first || this.#closed || this.#epoch !== epoch) return err({ kind: this.#closed ? "disconnected" : "denied" });
      let attested: Awaited<ReturnType<PatientAuthority["attest"]>>;
      try { attested = await this.#authority.attest(Object.freeze({ scope: this.#scope,
        callId: this.#callId, sessionId: this.#sessionId, candidateIds: first, token, operation,
        policyVersion: this.#policyVersion, signal })); }
      catch { return err({ kind: "unavailable" }); }
      if (this.#closed || this.#epoch !== epoch) return err({ kind: this.#closed ? "disconnected" : "denied" });
      if (!attested.ok) return err({ kind: attested.error.kind === "denied" ? "denied" : "unavailable" });
      const { patientId, operations: allowed } = attested.value;
      if (!validScope(attested.value.scope) || !sameScope(attested.value.scope, this.#scope) ||
          attested.value.callId !== this.#callId || attested.value.sessionId !== this.#sessionId ||
          attested.value.policyVersion !== this.#policyVersion || !first.includes(patientId) ||
          !Array.isArray(allowed) || allowed.length < 1 ||
          allowed.some(value => !operations.includes(value)) || new Set(allowed).size !== allowed.length ||
          !allowed.includes(operation)) return err({ kind: "denied" });
      const permitted = Object.freeze([...allowed]);
      const latest = await this.#candidates();
      if (!latest || latest.length !== first.length || latest.some((id, index) => id !== first[index]) ||
          !await this.#enabled() || this.#closed || this.#epoch !== epoch) {
        return err({ kind: this.#closed ? "disconnected" : "denied" });
      }
      const now = instant(this.#clock());
      if (now === undefined) return err({ kind: "unavailable" });
      if (this.#closed || this.#epoch !== epoch) return err({ kind: this.#closed ? "disconnected" : "denied" });
      const sourceExpiry = attested.value.expiresAt === undefined ? now + maxProofMs : instant(attested.value.expiresAt);
      if (sourceExpiry === undefined || sourceExpiry <= now + 120_000) return err({ kind: "denied" });
      const proof: LiveProof = { patientId, verificationRef: randomBytes(32).toString("base64url"),
        operations: permitted, expiresAt: new Date(Math.min(now + maxProofMs, sourceExpiry)).toISOString() };
      this.#proof = proof;
      return ok({ verificationRef: proof.verificationRef, expiresAt: proof.expiresAt });
    } catch { return err({ kind: "unavailable" }); }
  }

  async #refresh(proof: LiveProof, operation: PatientOperation, external?: AbortSignal): Promise<boolean> {
    const revalidate = this.#authority.revalidate;
    if (!revalidate) return true; // Existing owning-host verifiers use their versioned permission source.
    const controller = new AbortController(); this.#refreshes.add(controller);
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<boolean>(resolve => { onAbort = () => resolve(false); signal.addEventListener("abort", onAbort); if (signal.aborted) onAbort(); });
    try {
      return await Promise.race([Promise.resolve().then(() => signal.aborted ? false : revalidate.call(this.#authority, {
        scope: this.#scope, callId: this.#callId, sessionId: this.#sessionId, patientId: proof.patientId,
        operation, policyVersion: this.#policyVersion, signal })), stopped]) === true;
    } catch { return false; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); controller.abort(); this.#refreshes.delete(controller); }
  }

  async verifyOperation(scope: LocationScope, verificationRef: string, operation: PatientOperation,
                        now: string, signal?: AbortSignal): Promise<Result<VerifiedPatient, HostReadFailure>> {
    const proof = this.#proof;
    if (signal?.aborted) return err({ kind: "unavailable", target: "patient" });
    if (this.#closed || !validScope(scope) || !sameScope(scope, this.#scope) || typeof verificationRef !== "string" ||
        !operations.includes(operation) || !proof || proof.verificationRef !== verificationRef ||
        !proof.operations.includes(operation)) return err({ kind: "notFound", target: "patient" });
    let clockMs: number | undefined;
    try { clockMs = instant(this.#clock()); }
    catch { return err({ kind: "unavailable", target: "patient" }); }
    const suppliedMs = instant(now);
    if (clockMs === undefined || suppliedMs === undefined || Math.abs(clockMs - suppliedMs) > 30_000) {
      return err({ kind: "unavailable", target: "patient" });
    }
    // The appointment adapter requires more than two minutes of proof validity.
    if (instant(proof.expiresAt)! <= clockMs + 120_000) {
      this.#proof = undefined;
      return err({ kind: "expired", target: "patient" });
    }
    if (!await this.#enabled() || signal?.aborted || this.#closed || this.#proof !== proof) {
      if (this.#proof === proof) this.#proof = undefined;
      return err({ kind: "unavailable", target: "patient" });
    }
    if (!await this.#refresh(proof, operation, signal) || signal?.aborted || this.#closed || this.#proof !== proof || !await this.#enabled()) {
      if (this.#proof === proof) this.#proof = undefined;
      return err({ kind: "notFound", target: "patient" });
    }
    let freshMs: number | undefined;
    try { freshMs = instant(this.#clock()); }
    catch { return err({ kind: "unavailable", target: "patient" }); }
    if (freshMs === undefined || Math.abs(freshMs - suppliedMs) > 30_000) {
      return err({ kind: "unavailable", target: "patient" });
    }
    if (instant(proof.expiresAt)! <= freshMs + 120_000) {
      this.#proof = undefined;
      return err({ kind: "expired", target: "patient" });
    }
    if (signal?.aborted || this.#closed || this.#proof !== proof) return err({ kind: "unavailable", target: "patient" });
    return ok({ scope: structuredClone(this.#scope), patientRef: proof.patientId,
      verificationRef: proof.verificationRef, expiresAt: proof.expiresAt });
  }

  verifyPatient(scope: LocationScope, verificationRef: string, now: string, signal?: AbortSignal): Promise<Result<VerifiedPatient, HostReadFailure>> {
    return this.verifyOperation(scope, verificationRef, "appointments.read", now, signal);
  }

  revoke(): void {
    this.#epoch += 1;
    this.#attemptAbort?.abort();
    for (const controller of this.#refreshes) controller.abort();
    this.#proof = undefined;
  }

  dispose(): void {
    this.#closed = true;
    this.revoke();
    this.#presentedNumber = undefined;
  }
}
