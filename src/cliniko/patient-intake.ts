import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { ClinikoPatientCandidateReader } from "./patients.ts";
import type { ClinikoClinicScope, ClinikoPatientConfig } from "./patients.ts";
import { claimClinikoBudget, ClinikoReadBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

/** Provider edge only. The caller runtime does not construct this adapter. */
export type ClinikoIntakeRequest = Readonly<{
  scope: ClinikoClinicScope;
  attemptRef: string;
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
  acceptedPrivacyPolicy: true;
}>;

export type ClinikoIntakeOutcome =
  | Readonly<{ kind: "created"; patientRef: string }>
  | Readonly<{ kind: "existingCandidate" | "ambiguous" | "uncertain" }>;

export type ClinikoIntakeFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidQuery" | "forbidden" | "rateLimited" | "unavailable" |
    "malformed" | "tooManyResults";
  resetAt?: string;
}>;

const idPattern = /^[1-9][0-9]{0,18}$/;
const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const refPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const maxAttempts = 10_000;
const maxResponseBytes = 100_000;

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

function validRequest(value: unknown): value is ClinikoIntakeRequest {
  const request = record(value);
  const scope = record(request?.scope);
  return !!request && !!scope && [scope.tenantId, scope.clinicId].every(value =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 256) &&
    typeof request.attemptRef === "string" && refPattern.test(request.attemptRef) &&
    validName(request.firstName, 50) && validName(request.lastName, 255) &&
    typeof request.email === "string" && request.email.length <= 254 && emailPattern.test(request.email) &&
    validDate(request.dateOfBirth) && typeof request.patientPhone === "string" &&
    request.patientPhone.length > 0 && request.patientPhone.length <= 50 &&
    !/[\u0000-\u001f\u007f]/.test(request.patientPhone) &&
    (request.phoneType === "Mobile" || request.phoneType === "Home" || request.phoneType === "Work") &&
    (request.caller === "patient" || request.caller === "proxy") &&
    typeof request.consentRef === "string" && refPattern.test(request.consentRef) &&
    typeof request.authorityRef === "string" && refPattern.test(request.authorityRef) &&
    request.acceptedPrivacyPolicy === true;
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
  private readonly attempted = new Set<string>();

  private constructor(config: ClinikoPatientConfig, reader: ClinikoPatientCandidateReader, fetchPort: typeof fetch) {
    this.scope = { ...config.scope };
    this.baseUrl = `https://api.${config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)![1]}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.reader = reader;
    this.rateBudget = config.rateBudget!;
    this.fetchPort = fetchPort;
  }

  static create(config: ClinikoPatientConfig, fetchPort: typeof fetch = fetch):
    Result<ClinikoPatientIntakeEdge, ClinikoIntakeFailure> {
    if (!config || typeof config !== "object" ||
        (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget))) return err({ kind: "invalidConfig" });
    const shared = { ...config, rateBudget: config.rateBudget ?? new ClinikoReadBudget() };
    const reader = ClinikoPatientCandidateReader.create(shared, fetchPort);
    return reader.ok ? ok(new ClinikoPatientIntakeEdge(shared, reader.value, fetchPort)) : reader;
  }

  /** A possible send consumes the attempt. Unknown outcomes never trigger another POST. */
  async createOnce(request: ClinikoIntakeRequest): Promise<Result<ClinikoIntakeOutcome, ClinikoIntakeFailure>> {
    if (!validRequest(request)) return err({ kind: "invalidQuery" });
    if (request.scope.tenantId !== this.scope.tenantId || request.scope.clinicId !== this.scope.clinicId) {
      return err({ kind: "scopeMismatch" });
    }
    if (this.attempted.has(request.attemptRef)) return err({ kind: "invalidQuery" });
    if (this.attempted.size >= maxAttempts) return err({ kind: "unavailable" });
    // Claim before any await so racing calls through this instance cannot both send.
    this.attempted.add(request.attemptRef);
    const candidates = await this.reader.findByEmailAndBirthDate(request.scope, request.email, request.dateOfBirth);
    if (!candidates.ok) return err(candidates.error);
    if (candidates.value.kind === "one") return ok({ kind: "existingCandidate" });
    if (candidates.value.kind === "ambiguous") return ok({ kind: "ambiguous" });
    const limited = await claimClinikoBudget(this.rateBudget);
    if (limited) return err(limited);
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}/patients`, {
        method: "POST", headers: { Accept: "application/json", Authorization: this.authorization,
          "Content-Type": "application/json", "User-Agent": this.userAgent },
        body: JSON.stringify({ first_name: request.firstName, last_name: request.lastName,
          date_of_birth: request.dateOfBirth, email: request.email,
          patient_phone_numbers: [{ number: request.patientPhone, phone_type: request.phoneType }],
          accepted_privacy_policy: true }),
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { return ok({ kind: "uncertain" }); }
    if (response.status === 429) await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 201) return ok({ kind: "uncertain" });
    const row = await boundedPatient(response);
    if (!row || typeof row.id !== "string" || !idPattern.test(row.id) ||
        row.first_name !== request.firstName || row.last_name !== request.lastName ||
        typeof row.email !== "string" || row.email.toLowerCase() !== request.email.toLowerCase() ||
        row.date_of_birth !== request.dateOfBirth || row.accepted_privacy_policy !== true ||
        row.archived_at !== null) return ok({ kind: "uncertain" });
    return ok({ kind: "created", patientRef: `cliniko:patient:${row.id}` });
  }
}
