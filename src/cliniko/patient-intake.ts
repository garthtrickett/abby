import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { ClinikoPatientCandidateReader } from "./patients.ts";
import type { ClinikoClinicScope, ClinikoPatientConfig } from "./patients.ts";
import { claimClinikoBudget, ClinikoReadBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

/** Provider edge only. The caller runtime does not construct this adapter. */
export type ClinikoIntakeRequest = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  attemptRef: string;
  policyVersion: string;
  firstName: string;
  lastName: string;
  email: string;
  dateOfBirth: string;
  patientPhone: string;
  phoneType: "Mobile" | "Home" | "Work";
  caller: "patient" | "proxy";
  /** A trusted host must bind these to this patient, call, policy, and operation. */
  consentRef: string;
  authorityRef: string;
}>;

export type ClinikoIntakeAttestation = Readonly<{
  scope: LocationScope;
  callId: string;
  sessionId: string;
  attemptRef: string;
  policyVersion: string;
  draftDigest: string;
  caller: ClinikoIntakeRequest["caller"];
  consentRef: string;
  authorityRef: string;
  privacyAccepted: true;
  proxyAuthorized: boolean;
  expiresAt: string;
}>;

/** The host resolves these references against its own call-scoped consent and authority records. */
export type ClinikoIntakeAuthority = Readonly<{
  attest(request: ClinikoIntakeRequest, phase: "read" | "send"): Promise<ClinikoIntakeAttestation | null>;
}>;

export type ClinikoIntakeOutcome =
  | Readonly<{ kind: "created"; patientRef: string }>
  | Readonly<{ kind: "existingCandidate" | "ambiguous" | "uncertain" }>;

export type ClinikoIntakeFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidQuery" | "unauthorized" | "forbidden" | "rateLimited" | "unavailable" |
    "malformed" | "tooManyResults";
  resetAt?: string;
}>;

const idPattern = /^[1-9][0-9]{0,18}$/;
const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const refPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const maxAttempts = 10_000;
const maxResponseBytes = 100_000;
const maxAttestationAgeMs = 10 * 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validName(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function validClinikoIntakeRequest(value: unknown): value is ClinikoIntakeRequest {
  const request = record(value);
  const scope = record(request?.scope);
  return !!request && !!scope && [scope.tenantId, scope.clinicId, scope.locationId].every(value =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 256) &&
    typeof request.callId === "string" && refPattern.test(request.callId) &&
    typeof request.sessionId === "string" && refPattern.test(request.sessionId) &&
    typeof request.attemptRef === "string" && refPattern.test(request.attemptRef) &&
    typeof request.policyVersion === "string" && refPattern.test(request.policyVersion) &&
    validName(request.firstName, 50) && validName(request.lastName, 255) &&
    typeof request.email === "string" && request.email.length <= 254 && emailPattern.test(request.email) &&
    validDate(request.dateOfBirth) && typeof request.patientPhone === "string" &&
    request.patientPhone.length > 0 && request.patientPhone.length <= 50 &&
    !/[\u0000-\u001f\u007f]/.test(request.patientPhone) &&
    (request.phoneType === "Mobile" || request.phoneType === "Home" || request.phoneType === "Work") &&
    (request.caller === "patient" || request.caller === "proxy") &&
    typeof request.consentRef === "string" && refPattern.test(request.consentRef) &&
    typeof request.authorityRef === "string" && refPattern.test(request.authorityRef);
}

/** Transient digest lets the host attest to every field that will enter Cliniko. */
export function clinikoIntakeDraftDigest(request: ClinikoIntakeRequest): string {
  return createHash("sha256").update(JSON.stringify([
    request.firstName, request.lastName, request.email, request.dateOfBirth,
    request.patientPhone, request.phoneType,
  ])).digest("hex");
}

function validAttestation(value: unknown, request: ClinikoIntakeRequest, now: string): boolean {
  const proof = record(value);
  const scope = record(proof?.scope);
  const current = Date.parse(now);
  const expires = typeof proof?.expiresAt === "string" ? Date.parse(proof.expiresAt) : NaN;
  return !!proof && !!scope && scope.tenantId === request.scope.tenantId &&
    scope.clinicId === request.scope.clinicId && scope.locationId === request.scope.locationId &&
    proof.callId === request.callId &&
    proof.sessionId === request.sessionId && proof.attemptRef === request.attemptRef &&
    proof.policyVersion === request.policyVersion && proof.draftDigest === clinikoIntakeDraftDigest(request) &&
    proof.caller === request.caller && proof.consentRef === request.consentRef &&
    proof.authorityRef === request.authorityRef && proof.privacyAccepted === true &&
    typeof proof.proxyAuthorized === "boolean" &&
    (request.caller === "patient" || proof.proxyAuthorized === true) &&
    Number.isFinite(current) && Number.isFinite(expires) &&
    expires > current && expires <= current + maxAttestationAgeMs;
}

async function boundedPatient(response: Response): Promise<Record<string, unknown> | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxResponseBytes) { await reader.cancel(); return undefined; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { return undefined; }
  finally { reader.releaseLock(); }
}

/** Exact candidate search precedes one possible POST; it is not an atomic uniqueness guarantee. */
export class ClinikoPatientIntakeEdge {
  private readonly scope: ClinikoClinicScope;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly reader: ClinikoPatientCandidateReader;
  private readonly rateBudget: ClinikoRequestBudget;
  private readonly fetchPort: typeof fetch;
  private readonly authority: ClinikoIntakeAuthority;
  private readonly clock: () => string;
  private readonly attempted = new Set<string>();

  private constructor(config: ClinikoPatientConfig, reader: ClinikoPatientCandidateReader,
                      authority: ClinikoIntakeAuthority, fetchPort: typeof fetch, clock: () => string) {
    this.scope = { ...config.scope };
    this.baseUrl = `https://api.${config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)![1]}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.reader = reader;
    this.rateBudget = config.rateBudget!;
    this.fetchPort = fetchPort;
    this.authority = authority;
    this.clock = clock;
  }

  static create(config: ClinikoPatientConfig, authority: ClinikoIntakeAuthority,
                fetchPort: typeof fetch = fetch, clock: () => string = () => new Date().toISOString()):
    Result<ClinikoPatientIntakeEdge, ClinikoIntakeFailure> {
    if (!config || typeof config !== "object" ||
        (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget)) ||
        !authority || typeof authority.attest !== "function" || typeof clock !== "function") {
      return err({ kind: "invalidConfig" });
    }
    const shared = { ...config, rateBudget: config.rateBudget ?? new ClinikoReadBudget() };
    const reader = ClinikoPatientCandidateReader.create(shared, fetchPort, clock);
    return reader.ok ? ok(new ClinikoPatientIntakeEdge(shared, reader.value, authority, fetchPort, clock)) : reader;
  }

  private async authorized(input: ClinikoIntakeRequest, phase: "read" | "send"): Promise<boolean> {
    try {
      const attestation = await this.authority.attest(structuredClone(input), phase);
      return validAttestation(attestation, input, this.clock());
    } catch { return false; }
  }

  /** A possible send consumes the attempt. Unknown outcomes never trigger another POST. */
  async createOnce(request: ClinikoIntakeRequest): Promise<Result<ClinikoIntakeOutcome, ClinikoIntakeFailure>> {
    let input: ClinikoIntakeRequest;
    try { input = structuredClone(request); }
    catch { return err({ kind: "invalidQuery" }); }
    if (!validClinikoIntakeRequest(input)) return err({ kind: "invalidQuery" });
    if (input.scope.tenantId !== this.scope.tenantId || input.scope.clinicId !== this.scope.clinicId) {
      return err({ kind: "scopeMismatch" });
    }
    if (this.attempted.has(input.attemptRef)) return err({ kind: "invalidQuery" });
    if (this.attempted.size >= maxAttempts) return err({ kind: "unavailable" });
    // Claim before any await so racing calls through this instance cannot both send.
    this.attempted.add(input.attemptRef);
    if (!await this.authorized(input, "read")) return err({ kind: "unauthorized" });
    const candidates = await this.reader.findByEmailAndBirthDate(input.scope, input.email, input.dateOfBirth);
    if (!candidates.ok) return err(candidates.error);
    if (candidates.value.kind === "one") return ok({ kind: "existingCandidate" });
    if (candidates.value.kind === "ambiguous") return ok({ kind: "ambiguous" });
    const limited = await claimClinikoBudget(this.rateBudget);
    if (limited) return err(limited);
    // A host policy or consent can change while Cliniko is answering the duplicate check.
    if (!await this.authorized(input, "send")) return err({ kind: "unauthorized" });
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}/patients`, {
        method: "POST", headers: { Accept: "application/json", Authorization: this.authorization,
          "Content-Type": "application/json", "User-Agent": this.userAgent },
        body: JSON.stringify({ first_name: input.firstName, last_name: input.lastName,
          date_of_birth: input.dateOfBirth, email: input.email,
          patient_phone_numbers: [{ number: input.patientPhone, phone_type: input.phoneType }],
          accepted_privacy_policy: true }),
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { return ok({ kind: "uncertain" }); }
    if (response.status === 429) await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 201) return ok({ kind: "uncertain" });
    const row = await boundedPatient(response);
    if (!row || typeof row.id !== "string" || !idPattern.test(row.id) ||
        row.first_name !== input.firstName || row.last_name !== input.lastName ||
        typeof row.email !== "string" || row.email.toLowerCase() !== input.email.toLowerCase() ||
        row.date_of_birth !== input.dateOfBirth || row.accepted_privacy_policy !== true ||
        row.archived_at !== null) return ok({ kind: "uncertain" });
    return ok({ kind: "created", patientRef: `cliniko:patient:${row.id}` });
  }
}
