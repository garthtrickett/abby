import { randomUUID } from "node:crypto";
import { clinikoIntakeDraftDigest, validClinikoIntakeRequest } from "../cliniko/patient-intake.ts";
import type { ClinikoIntakeAttestation, ClinikoIntakeAuthority, ClinikoIntakeRequest } from "../cliniko/patient-intake.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

type IntakeDraft = Pick<ClinikoIntakeRequest,
  "firstName" | "lastName" | "email" | "dateOfBirth" | "patientPhone" | "phoneType">;

export type HostIntakeEvidence = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  draftRef: string;
  consentRef: string;
  authorityRef: string;
  draft: IntakeDraft;
  caller: ClinikoIntakeRequest["caller"];
  privacyAccepted: boolean;
  proxyAuthorized: boolean;
  expiresAt: string;
}>;

export type IntakeEvidenceSource = Readonly<{
  /** Resolve an approved draft and independently recorded consent/authority in the owning host. */
  resolve(input: Readonly<{
    scope: LocationScope;
    callId: string;
    sessionId: string;
    policyVersion: string;
    draftRef: string;
    consentRef: string;
    authorityRef: string;
    signal: AbortSignal;
  }>): Promise<Result<HostIntakeEvidence, Readonly<{ kind: "denied" | "unavailable" }>>>;
}>;

export type TransientIntakeAuthorityConfig = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  policyVersion: string;
  source: IntakeEvidenceSource;
  clock?: () => string;
  timeoutMs?: number;
}>;

export type IntakePreparationFailure = Readonly<{
  kind: "invalidQuery" | "denied" | "unavailable" | "alreadyPrepared" | "disconnected";
}>;

type Pending = Readonly<{ request: ClinikoIntakeRequest; draftRef: string; digest: string }>;
type EvidenceFailure = Readonly<{ kind: "denied" | "unavailable" }>;
const maxProofMs = 10 * 60_000;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const refPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function validScope(value: unknown): value is LocationScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  return [scope.tenantId, scope.clinicId, scope.locationId].every(item =>
    typeof item === "string" && item.trim().length > 0 && item.length <= 256);
}

function currentTime(clock: () => string): number | undefined {
  try {
    const now = clock();
    if (!instantPattern.test(now)) return undefined;
    const time = Date.parse(now);
    return Number.isFinite(time) ? time : undefined;
  } catch { return undefined; }
}

/** A single call owns one transient intake attempt; no patient draft is persisted here. */
export class TransientIntakeAuthority implements ClinikoIntakeAuthority {
  readonly #scope: LocationScope;
  readonly #callId: string;
  readonly #sessionId: string;
  readonly #policyVersion: string;
  readonly #source: IntakeEvidenceSource;
  readonly #clock: () => string;
  readonly #timeoutMs: number;
  #pending: Pending | undefined;
  #busy = false;
  #sendClaimed = false;
  #closed = false;
  #epoch = 0;
  readonly #lifetime = new AbortController();

  constructor(config: TransientIntakeAuthorityConfig) {
    if (!validScope(config.scope) || ![config.callId, config.sessionId, config.policyVersion].every(value =>
      typeof value === "string" && refPattern.test(value)) ||
      !config.source || typeof config.source.resolve !== "function" ||
      (config.clock !== undefined && typeof config.clock !== "function") ||
      (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 1 || config.timeoutMs > 30_000))) throw new TypeError("invalid intake authority configuration");
    this.#scope = Object.freeze(structuredClone(config.scope));
    this.#callId = config.callId;
    this.#sessionId = config.sessionId;
    this.#policyVersion = config.policyVersion;
    this.#source = config.source;
    this.#clock = config.clock ?? (() => new Date().toISOString());
    this.#timeoutMs = config.timeoutMs ?? 15_000;
  }

  async #resolve(draftRef: string, consentRef: string, authorityRef: string, consumer?: AbortSignal):
    Promise<Result<HostIntakeEvidence, EvidenceFailure>> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.#lifetime.signal, ...(consumer ? [consumer] : [])]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const epoch = this.#epoch;
    try {
      if (signal.aborted) return err({ kind: "unavailable" });
      const pending = Promise.resolve().then(() => signal.aborted ? undefined : this.#source.resolve({ scope: this.#scope,
        callId: this.#callId, sessionId: this.#sessionId, policyVersion: this.#policyVersion,
        draftRef, consentRef, authorityRef, signal }));
      timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const result = await awaitUntilAbort(pending, signal);
      if (signal.aborted || this.#closed || this.#epoch !== epoch || !result) return err({ kind: "unavailable" });
      return result.ok ? ok(structuredClone(result.value)) : err({ kind: result.error?.kind === "denied" ? "denied" : "unavailable" });
    } catch { return err({ kind: "unavailable" }); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }

  #validEvidence(evidence: HostIntakeEvidence | undefined, refs: Readonly<{
    draftRef: string; consentRef: string; authorityRef: string;
  }>): evidence is HostIntakeEvidence {
    const now = currentTime(this.#clock);
    const expires = typeof evidence?.expiresAt === "string" && instantPattern.test(evidence.expiresAt)
      ? Date.parse(evidence.expiresAt) : NaN;
    return !!evidence && validScope(evidence.scope) && sameScope(evidence.scope, this.#scope) &&
      evidence.draft !== null && typeof evidence.draft === "object" && !Array.isArray(evidence.draft) &&
      evidence.callId === this.#callId && evidence.sessionId === this.#sessionId &&
      evidence.policyVersion === this.#policyVersion && evidence.draftRef === refs.draftRef &&
      evidence.consentRef === refs.consentRef && evidence.authorityRef === refs.authorityRef &&
      evidence.privacyAccepted === true && typeof evidence.proxyAuthorized === "boolean" &&
      (evidence.caller === "patient" || (evidence.caller === "proxy" && evidence.proxyAuthorized)) &&
      now !== undefined && Number.isFinite(expires) && expires > now && expires <= now + maxProofMs;
  }

  /** Only the trusted call owner supplies host-owned references; a model cannot issue one. */
  async prepare(draftRef: string, consentRef: string, authorityRef: string, signal?: AbortSignal):
    Promise<Result<ClinikoIntakeRequest, IntakePreparationFailure>> {
    if (this.#closed) return err({ kind: "disconnected" });
    if (![draftRef, consentRef, authorityRef].every(ref => typeof ref === "string" && refPattern.test(ref))) {
      return err({ kind: "invalidQuery" });
    }
    if (this.#busy || this.#pending) return err({ kind: "alreadyPrepared" });
    this.#busy = true;
    const epoch = this.#epoch;
    try {
      const resolved = await this.#resolve(draftRef, consentRef, authorityRef, signal);
      if (this.#closed || this.#epoch !== epoch) return err({ kind: "disconnected" });
      if (!resolved.ok) return err(resolved.error);
      const evidence = resolved.value;
      if (!this.#validEvidence(evidence, { draftRef, consentRef, authorityRef })) return err({ kind: "denied" });
      const request: ClinikoIntakeRequest = { scope: this.#scope, callId: this.#callId,
        sessionId: this.#sessionId, attemptRef: randomUUID(), policyVersion: this.#policyVersion,
        firstName: evidence.draft.firstName, lastName: evidence.draft.lastName, email: evidence.draft.email,
        dateOfBirth: evidence.draft.dateOfBirth, patientPhone: evidence.draft.patientPhone,
        phoneType: evidence.draft.phoneType, caller: evidence.caller, consentRef, authorityRef };
      if (!validClinikoIntakeRequest(request)) return err({ kind: "denied" });
      const pending: Pending = { request: structuredClone(request), draftRef,
        digest: clinikoIntakeDraftDigest(request) };
      this.#pending = pending;
      return ok(structuredClone(request));
    } catch { return err({ kind: "unavailable" }); }
    finally { this.#busy = false; }
  }

  async attest(request: ClinikoIntakeRequest, phase: "read" | "send", signal?: AbortSignal): Promise<ClinikoIntakeAttestation | null> {
    try { request = structuredClone(request); } catch { return null; }
    const pending = this.#pending;
    if (this.#closed || this.#sendClaimed || (phase !== "read" && phase !== "send") ||
        !pending || !validClinikoIntakeRequest(request) ||
        !sameScope(request.scope, this.#scope) || request.callId !== this.#callId ||
        request.sessionId !== this.#sessionId || request.policyVersion !== this.#policyVersion ||
        request.attemptRef !== pending.request.attemptRef ||
        request.consentRef !== pending.request.consentRef ||
        request.authorityRef !== pending.request.authorityRef ||
        request.caller !== pending.request.caller ||
        clinikoIntakeDraftDigest(request) !== pending.digest) return null;
    const epoch = this.#epoch;
    const resolved = await this.#resolve(pending.draftRef, request.consentRef, request.authorityRef, signal);
    if (!resolved.ok) return null;
    const evidence = resolved.value;
    if (this.#closed || this.#epoch !== epoch || this.#pending !== pending ||
        !this.#validEvidence(evidence, { draftRef: pending.draftRef,
          consentRef: request.consentRef, authorityRef: request.authorityRef }) ||
        evidence.caller !== request.caller) return null;
    const refreshed: ClinikoIntakeRequest = { ...request,
      firstName: evidence.draft.firstName, lastName: evidence.draft.lastName, email: evidence.draft.email,
      dateOfBirth: evidence.draft.dateOfBirth, patientPhone: evidence.draft.patientPhone, phoneType: evidence.draft.phoneType };
    if (!validClinikoIntakeRequest(refreshed) ||
        clinikoIntakeDraftDigest(refreshed) !== pending.digest) return null;
    if (this.#sendClaimed) return null;
    if (phase === "send") this.#sendClaimed = true;
    return { scope: this.#scope, callId: this.#callId, sessionId: this.#sessionId,
      attemptRef: request.attemptRef, policyVersion: this.#policyVersion,
      draftDigest: pending.digest, caller: request.caller,
      consentRef: request.consentRef, authorityRef: request.authorityRef,
      privacyAccepted: true, proxyAuthorized: evidence.proxyAuthorized,
      expiresAt: evidence.expiresAt };
  }

  dispose(): void {
    this.#closed = true;
    this.#epoch += 1;
    this.#lifetime.abort();
    this.#pending = undefined;
  }
}
