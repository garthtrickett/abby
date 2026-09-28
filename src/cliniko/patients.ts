import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";

export type ClinikoClinicScope = Pick<LocationScope, "tenantId" | "clinicId">;
export type ClinikoPatientConfig = Readonly<{
  scope: ClinikoClinicScope;
  apiKey: string;
  contactEmail: string;
}>;

/** A candidate is never a verification proof or permission to disclose a record. */
export type ClinikoPatientSearch = Readonly<{ scope: ClinikoClinicScope; observedAt: string }> & (
  | Readonly<{ kind: "none" | "ambiguous" }>
  | Readonly<{ kind: "one"; candidateRef: string }>
);
export type ClinikoPatientFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidQuery" | "forbidden" | "rateLimited" |
    "unavailable" | "malformed" | "tooManyResults";
  resetAt?: string;
}>;

const maxBodyBytes = 1_000_000;
const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validScope(scope: unknown): scope is ClinikoClinicScope {
  const value = record(scope);
  return !!value && [value.tenantId, value.clinicId]
    .every(part => typeof part === "string" && !!part.trim() && part.length <= 256);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && emailPattern.test(value);
}

async function boundedJson(response: Response): Promise<Result<unknown, ClinikoPatientFailure>> {
  if (!response.body) return err({ kind: "malformed" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        return err({ kind: "tooManyResults" });
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return ok(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } catch {
    return err({ kind: "malformed" });
  } finally {
    reader.releaseLock();
  }
}

/** Read-only, exact candidate search. The clinic must perform its own verification afterwards. */
export class ClinikoPatientCandidateReader {
  private readonly scope: ClinikoClinicScope;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly fetchPort: typeof fetch;
  private readonly clock: () => string;

  private constructor(config: ClinikoPatientConfig, shard: string, fetchPort: typeof fetch, clock: () => string) {
    this.scope = { tenantId: config.scope.tenantId, clinicId: config.scope.clinicId };
    this.baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.fetchPort = fetchPort;
    this.clock = clock;
  }

  static create(config: ClinikoPatientConfig, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()): Result<ClinikoPatientCandidateReader, ClinikoPatientFailure> {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) || !validScope(config.scope) ||
        !validEmail(config.contactEmail) || typeof fetchPort !== "function" || typeof clock !== "function") {
      return err({ kind: "invalidConfig" });
    }
    return ok(new ClinikoPatientCandidateReader(config, shard, fetchPort, clock));
  }

  /** Search by two documented exact filters; no phone or partial-name scan is attempted. */
  async findByEmailAndBirthDate(scope: ClinikoClinicScope, email: string, dateOfBirth: string):
    Promise<Result<ClinikoPatientSearch, ClinikoPatientFailure>> {
    if (!validScope(scope) || scope.tenantId !== this.scope.tenantId || scope.clinicId !== this.scope.clinicId) {
      return err({ kind: "scopeMismatch" });
    }
    if (!validEmail(email) || !validDate(dateOfBirth)) return err({ kind: "invalidQuery" });
    let observedAt: string;
    try { observedAt = this.clock(); }
    catch { return err({ kind: "unavailable" }); }
    if (typeof observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(observedAt) ||
        !Number.isFinite(Date.parse(observedAt))) return err({ kind: "unavailable" });

    const query = new URLSearchParams({ page: "1", per_page: "2" });
    query.append("q[]", `email:=${email}`);
    query.append("q[]", `date_of_birth:=${dateOfBirth}`);
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}/patients?${query}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: this.authorization, "User-Agent": this.userAgent },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { return err({ kind: "unavailable" }); }
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 429) {
      const reset = response.headers.get("X-RateLimit-Reset");
      const seconds = reset && /^[0-9]+$/.test(reset) ? Number(reset) : NaN;
      return err(Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8_640_000_000_000
        ? { kind: "rateLimited", resetAt: new Date(seconds * 1000).toISOString() } : { kind: "rateLimited" });
    }
    if (response.status >= 500 || response.status === 404) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    const parsed = await boundedJson(response);
    if (!parsed.ok) return parsed;
    const body = record(parsed.value);
    if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
        !Array.isArray(body.patients) || body.patients.length > 2 ||
        body.patients.length !== Math.min(Number(body.total_entries), 2)) return err({ kind: "malformed" });
    const ids = new Set<string>();
    for (const candidate of body.patients) {
      const patient = record(candidate);
      if (!patient || typeof patient.id !== "string" || !/^[1-9][0-9]*$/.test(patient.id) ||
          ids.has(patient.id) || typeof patient.email !== "string" ||
          patient.email.toLowerCase() !== email.toLowerCase() || patient.date_of_birth !== dateOfBirth ||
          patient.archived_at !== null) return err({ kind: "malformed" });
      ids.add(patient.id);
    }
    const base = { scope: structuredClone(this.scope), observedAt };
    if (body.total_entries === 0) return ok({ ...base, kind: "none" });
    if (Number(body.total_entries) > 1) return ok({ ...base, kind: "ambiguous" });
    return ok({ ...base, kind: "one", candidateRef: `cliniko:patient:${body.patients[0].id}` });
  }
}
