import type { PatientProofHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { AppointmentRead, AppointmentReadFailure, LocationScope, Result } from "../core/model.ts";

export type ClinikoAppointmentConfig = Readonly<{
  scope: LocationScope;
  apiKey: string;
  contactEmail: string;
  businessId: string;
}>;

export type { AppointmentRead, AppointmentReadFailure } from "../core/model.ts";

const maxBodyBytes = 1_000_000;
const perPage = 100;
const maxPages = 5;
const maxRangeMs = 90 * 86_400_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

async function boundedJson(response: Response): Promise<Result<unknown, AppointmentReadFailure>> {
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

/** Read-only provider edge. The proof host, not a caller-supplied patient ID, chooses the patient. */
export class ClinikoAppointmentReader {
  private readonly scope: LocationScope;
  private readonly businessId: string;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly proof: PatientProofHost;
  private readonly fetchPort: typeof fetch;
  private readonly clock: () => string;

  private constructor(config: ClinikoAppointmentConfig, shard: string, proof: PatientProofHost, fetchPort: typeof fetch, clock: () => string) {
    this.scope = structuredClone(config.scope);
    this.businessId = config.businessId;
    this.baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.proof = proof;
    this.fetchPort = fetchPort;
    this.clock = clock;
  }

  static create(config: ClinikoAppointmentConfig, proof: PatientProofHost, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()): Result<ClinikoAppointmentReader, AppointmentReadFailure> {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || typeof config.contactEmail !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) || !config.scope ||
        [config.scope.tenantId, config.scope.clinicId, config.scope.locationId].some(part => typeof part !== "string" || !part.trim()) ||
        !validId(config.businessId) || !proof || typeof proof.verifyPatient !== "function" ||
        typeof fetchPort !== "function" || typeof clock !== "function") return err({ kind: "invalidConfig" });
    return ok(new ClinikoAppointmentReader(config, shard, proof, fetchPort, clock));
  }

  private async get(path: string): Promise<Result<unknown, AppointmentReadFailure>> {
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}${path}`, {
        method: "GET", headers: { Accept: "application/json", Authorization: this.authorization, "User-Agent": this.userAgent },
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
    if (response.status >= 500) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    return boundedJson(response);
  }

  async list(scope: LocationScope, verificationRef: string, from: string, to: string, now: string): Promise<Result<AppointmentRead, AppointmentReadFailure>> {
    if (!sameScope(this.scope, scope)) return err({ kind: "scopeMismatch" });
    if (typeof verificationRef !== "string" || !verificationRef.trim() || verificationRef.length > 256) return err({ kind: "invalidProof" });
    const fromMs = instant(from);
    const toMs = instant(to);
    let observedAt: string;
    try { observedAt = this.clock(); }
    catch { return err({ kind: "unavailable" }); }
    const nowMs = instant(observedAt);
    const suppliedNowMs = instant(now);
    if (fromMs === undefined || toMs === undefined || nowMs === undefined || toMs <= fromMs || toMs - fromMs > maxRangeMs ||
        suppliedNowMs === undefined || Math.abs(suppliedNowMs - nowMs) > 30_000 ||
        fromMs < nowMs - 30_000 || fromMs - nowMs > 86_400_000) return err({ kind: "invalidRange" });

    let verified: Awaited<ReturnType<PatientProofHost["verifyPatient"]>>;
    try { verified = await this.proof.verifyPatient(scope, verificationRef, observedAt); }
    catch { return err({ kind: "unavailable" }); }
    if (!verified.ok) return err({ kind: verified.error.kind === "unavailable" ? "unavailable" : "invalidProof" });
    const patient = verified.value;
    if (!sameScope(patient.scope, scope) || patient.verificationRef !== verificationRef || !validId(patient.patientRef) ||
        instant(patient.expiresAt) === undefined || instant(patient.expiresAt)! <= nowMs + 120_000) return err({ kind: "invalidProof" });

    const businessResponse = await this.get(`/businesses/${this.businessId}`);
    if (!businessResponse.ok) return businessResponse;
    const business = record(businessResponse.value);
    if (!business || String(business.id) !== this.businessId || typeof business.time_zone_identifier !== "string" ||
        !business.time_zone_identifier.trim() || business.archived_at) return err({ kind: "malformed" });
    try { new Intl.DateTimeFormat("en-AU", { timeZone: business.time_zone_identifier }); }
    catch { return err({ kind: "malformed" }); }

    const appointments: { appointmentRef: string; startsAt: string; endsAt: string }[] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ page: String(page), per_page: String(perPage), sort: "starts_at" });
      query.append("q[]", `patient_id:=${patient.patientRef}`);
      query.append("q[]", `business_id:=${this.businessId}`);
      query.append("q[]", `starts_at:>${from}`);
      query.append("q[]", `starts_at:<${to}`);
      const fetched = await this.get(`/individual_appointments?${query}`);
      if (!fetched.ok) return fetched;
      const body = record(fetched.value);
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
          !Array.isArray(body.individual_appointments)) return err({ kind: "malformed" });
      if (Number(body.total_entries) > maxPages * perPage) return err({ kind: "tooManyResults" });
      if (total !== undefined && total !== body.total_entries) return err({ kind: "unavailable" });
      total = Number(body.total_entries);
      if (body.individual_appointments.length > perPage) return err({ kind: "malformed" });
      for (const candidate of body.individual_appointments) {
        const row = record(candidate);
        const patientSelf = record(record(row?.patient)?.links)?.self;
        const businessSelf = record(record(row?.business)?.links)?.self;
        const start = instant(row?.starts_at);
        const end = instant(row?.ends_at);
        if (!row || !validId(row.id) || seen.has(row.id) ||
            patientSelf !== `${this.baseUrl}/patients/${patient.patientRef}` ||
            businessSelf !== `${this.baseUrl}/businesses/${this.businessId}` ||
            start === undefined || end === undefined || end <= start || start <= fromMs || start >= toMs ||
            (row.cancelled_at !== null && row.cancelled_at !== undefined && instant(row.cancelled_at) === undefined) ||
            (row.archived_at !== null && row.archived_at !== undefined && instant(row.archived_at) === undefined) ||
            (row.deleted_at !== null && row.deleted_at !== undefined && instant(row.deleted_at) === undefined)) return err({ kind: "malformed" });
        seen.add(row.id);
        if (row.cancelled_at || row.archived_at || row.deleted_at) continue;
        appointments.push({ appointmentRef: row.id, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
      }
      if (seen.size > total) return err({ kind: "malformed" });
      if (seen.size >= total) break;
      if (body.individual_appointments.length === 0) return err({ kind: "unavailable" });
    }
    if (seen.size !== total) return err({ kind: "tooManyResults" });
    return ok({ scope: structuredClone(scope), sourceRef: `cliniko:business:${this.businessId}:appointments`,
      observedAt, timeZone: business.time_zone_identifier, patientRef: patient.patientRef,
      verificationRef, proofExpiresAt: patient.expiresAt, appointments });
  }
}
