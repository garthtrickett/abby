import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { claimClinikoBudget, ClinikoReadBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

export type ClinikoBookingConfig = Readonly<{
  scope: LocationScope;
  apiKey: string;
  contactEmail: string;
  businessId: string;
  practitionerId: string;
  appointmentTypeId: string;
  rateBudget?: ClinikoRequestBudget;
}>;

export type ClinikoBookingSelection = Readonly<Pick<ClinikoBookingConfig,
  "scope" | "businessId" | "practitionerId" | "appointmentTypeId">>;

/** The host must resolve proof, offer, policy, and caller confirmation before constructing this request. */
export type ClinikoBookingRequest = Readonly<{
  scope: LocationScope;
  patientId: string;
  startsAt: string;
  endsAt: string;
  marker: string;
}>;

export type ClinikoBookingFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidQuery" | "rateLimited" | "unavailable" |
    "forbidden" | "malformed" | "tooManyResults";
  resetAt?: string;
}>;

export type ClinikoBookingWrite =
  | Readonly<{ kind: "accepted"; appointmentRef: string }>
  | Readonly<{ kind: "uncertain" }>;

export type ClinikoBookingObservation = Readonly<{ scope: LocationScope; observedAt: string }> & (
  | Readonly<{ kind: "none" | "ambiguous" | "mismatch" }>
  | Readonly<{ kind: "one"; appointmentRef: string; active: boolean }>
);

const idPattern = /^[1-9][0-9]{0,18}$/;
const markerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const pageSize = 100;
const maxPages = 5;
const maxBodyBytes = 1_000_000;
const maxProcessAttempts = 10_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validScope(value: unknown): value is LocationScope {
  const scope = record(value);
  return !!scope && [scope.tenantId, scope.clinicId, scope.locationId]
    .every(part => typeof part === "string" && !!part.trim() && part.length <= 256);
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !instantPattern.test(value)) return undefined;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendarDay = new Date(Date.UTC(year!, month! - 1, day!));
  if (calendarDay.toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validStatus(row: Record<string, unknown>): boolean {
  return [row.cancelled_at, row.archived_at, row.deleted_at].every(value => value === null || instant(value) !== undefined);
}

function validRequest(value: unknown): value is ClinikoBookingRequest {
  const request = record(value);
  const start = instant(request?.startsAt), end = instant(request?.endsAt);
  return !!request && validScope(request.scope) && typeof request.patientId === "string" &&
    idPattern.test(request.patientId) && typeof request.marker === "string" &&
    markerPattern.test(request.marker) && start !== undefined && end !== undefined &&
    end > start && end - start <= 480 * 60_000;
}

function notes(marker: string): string { return `Abby booking ${marker}`; }

async function boundedJson(response: Response): Promise<Result<unknown, ClinikoBookingFailure>> {
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
  } catch { return err({ kind: "malformed" }); }
  finally { reader.releaseLock(); }
}

/** Stop waiting when a host-supplied signal aborts; the underlying budget or provider may still settle later. */
async function untilAbort<Value>(pending: Promise<Value>, signal?: AbortSignal): Promise<Value | undefined> {
  if (!signal) return pending;
  if (signal.aborted) { void pending.catch(() => undefined); return undefined; }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

/** Optional trusted host check after the final budget wait; never an agent-provided callback. */
async function permitted(hook: ((signal: AbortSignal) => Promise<boolean>) | undefined, signal: AbortSignal): Promise<boolean> {
  try {
    return typeof hook === "function" && await untilAbort(Promise.resolve().then(() => hook(signal)), signal) === true && !signal.aborted;
  } catch { return false; }
}

/** A provider edge only. It cannot establish slot exclusivity or authorize live booking. */
export class ClinikoBookingWriter {
  private readonly scope: LocationScope;
  private readonly config: Readonly<{ businessId: string; practitionerId: string; appointmentTypeId: string }>;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly rateBudget: ClinikoRequestBudget;
  private readonly fetchPort: typeof fetch;
  private readonly clock: () => string;
  private readonly attempted = new Set<string>();
  private readonly credentialHash: string;

  private constructor(config: ClinikoBookingConfig, shard: string, fetchPort: typeof fetch, clock: () => string) {
    this.scope = structuredClone(config.scope);
    this.config = { businessId: config.businessId, practitionerId: config.practitionerId,
      appointmentTypeId: config.appointmentTypeId };
    this.baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.rateBudget = config.rateBudget ?? new ClinikoReadBudget();
    this.fetchPort = fetchPort;
    this.clock = clock;
    this.credentialHash = clinikoCredentialFingerprint(config.apiKey);
  }

  static create(config: ClinikoBookingConfig, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()): Result<ClinikoBookingWriter, ClinikoBookingFailure> {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
        !validScope(config.scope) || typeof config.contactEmail !== "string" ||
        config.contactEmail.length > 254 || !emailPattern.test(config.contactEmail) ||
        ![config.businessId, config.practitionerId, config.appointmentTypeId].every(id =>
          typeof id === "string" && idPattern.test(id)) ||
        typeof fetchPort !== "function" || typeof clock !== "function" ||
        (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget))) return err({ kind: "invalidConfig" });
    return ok(new ClinikoBookingWriter(config, shard, fetchPort, clock));
  }

  /** Public provider IDs only; the booking host binds its exact offer to this writer. */
  selection(): ClinikoBookingSelection {
    return { scope: structuredClone(this.scope), ...this.config };
  }

  credentialFingerprint(): string { return this.credentialHash; }

  /** Read current provider conflicts; a clear result is not a reservation or atomic exclusion. */
  async inspectConflicts(appointmentRef: string, signal?: AbortSignal, beforeRead?: (signal: AbortSignal) => Promise<boolean>):
    Promise<Result<boolean, ClinikoBookingFailure>> {
    const id = typeof appointmentRef === "string"
      ? appointmentRef.match(/^cliniko:appointment:([1-9][0-9]{0,18})$/)?.[1] : undefined;
    if (!id) return err({ kind: "invalidQuery" });
    const readSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    if (readSignal.aborted) return err({ kind: "unavailable" });
    const limited = await untilAbort(claimClinikoBudget(this.rateBudget), readSignal);
    if (readSignal.aborted || limited === undefined) return err({ kind: "unavailable" });
    if (limited) return err(limited);
    if (beforeRead !== undefined && !await permitted(beforeRead, readSignal)) return err({ kind: "forbidden" });
    if (readSignal.aborted) return err({ kind: "unavailable" });
    let response: Response;
    try {
      const received = await untilAbort(this.fetchPort(`${this.baseUrl}/individual_appointments/${id}/conflicts`, {
        method: "GET", headers: { Accept: "application/json", Authorization: this.authorization,
          "User-Agent": this.userAgent }, redirect: "error", signal: readSignal,
      }), readSignal);
      if (!received || readSignal.aborted) return err({ kind: "unavailable" });
      response = received;
    } catch { return err({ kind: "unavailable" }); }
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 429) {
      const limited = await untilAbort(observeCliniko429(this.rateBudget,
        response.headers.get("X-RateLimit-Reset")), readSignal);
      return err(readSignal.aborted || !limited ? { kind: "unavailable" } : limited);
    }
    if (response.status >= 500 || response.status === 404) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    const parsed = await untilAbort(boundedJson(response), readSignal);
    if (!parsed || readSignal.aborted) return err({ kind: "unavailable" });
    if (!parsed.ok) return parsed;
    const exists = record(record(parsed.value)?.conflicts)?.exist;
    return typeof exists === "boolean" ? ok(exists) : err({ kind: "malformed" });
  }

  private matches(row: Record<string, unknown>, request: ClinikoBookingRequest): boolean {
    const link = (name: string) => record(record(row[name])?.links)?.self;
    return row.notes === notes(request.marker) && instant(row.starts_at) === instant(request.startsAt) &&
      instant(row.ends_at) === instant(request.endsAt) &&
      link("patient") === `${this.baseUrl}/patients/${request.patientId}` &&
      link("business") === `${this.baseUrl}/businesses/${this.config.businessId}` &&
      link("practitioner") === `${this.baseUrl}/practitioners/${this.config.practitionerId}` &&
      link("appointment_type") === `${this.baseUrl}/appointment_types/${this.config.appointmentTypeId}`;
  }

  /** At most one POST per marker in this process; abort before send prevents the POST. */
  async writeOnce(request: ClinikoBookingRequest, signal?: AbortSignal,
    beforeSend?: (signal: AbortSignal) => Promise<boolean>):
    Promise<Result<ClinikoBookingWrite, ClinikoBookingFailure>> {
    if (!validRequest(request)) return err({ kind: "invalidQuery" });
    request = structuredClone(request);
    if (!sameScope(this.scope, request.scope)) return err({ kind: "scopeMismatch" });
    if (this.attempted.has(request.marker)) return err({ kind: "invalidQuery" });
    if (this.attempted.size >= maxProcessAttempts) return err({ kind: "unavailable" });
    this.attempted.add(request.marker);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    if (requestSignal.aborted) return err({ kind: "unavailable" });
    const limited = await untilAbort(claimClinikoBudget(this.rateBudget), requestSignal);
    if (requestSignal.aborted || limited === undefined) return err({ kind: "unavailable" });
    if (limited) return err(limited);
    if (beforeSend !== undefined && !await permitted(beforeSend, requestSignal)) return err({ kind: "forbidden" });
    if (requestSignal.aborted) return err({ kind: "unavailable" });
    let response: Response;
    try {
      const received = await untilAbort(this.fetchPort(`${this.baseUrl}/individual_appointments`, {
        method: "POST", headers: { Accept: "application/json", Authorization: this.authorization,
          "Content-Type": "application/json", "User-Agent": this.userAgent },
        body: JSON.stringify({ business_id: this.config.businessId, practitioner_id: this.config.practitionerId,
          appointment_type_id: this.config.appointmentTypeId, patient_id: request.patientId,
          starts_at: request.startsAt, ends_at: request.endsAt, notes: notes(request.marker) }),
        redirect: "error", signal: requestSignal,
      }), requestSignal);
      if (!received || requestSignal.aborted) return ok({ kind: "uncertain" });
      response = received;
    } catch { return ok({ kind: "uncertain" }); }
    if (response.status === 429) {
      await untilAbort(observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset")), requestSignal);
    }
    if (response.status !== 201) return ok({ kind: "uncertain" });
    const parsed = await untilAbort(boundedJson(response), requestSignal);
    if (!parsed?.ok || requestSignal.aborted) return ok({ kind: "uncertain" });
    const row = record(parsed.value);
    if (!row || typeof row.id !== "string" || !idPattern.test(row.id) ||
        !this.matches(row, request) || !validStatus(row) ||
        row.cancelled_at !== null || row.archived_at !== null || row.deleted_at !== null) {
      return ok({ kind: "uncertain" });
    }
    return ok({ kind: "accepted", appointmentRef: `cliniko:appointment:${row.id}` });
  }

  /** Exact active read-back for a clear create response, including the clinic-approved duration.
   * A clear read is best-effort evidence only; it cannot identify a writer after a lost response. */
  async inspectCreated(request: ClinikoBookingRequest, appointmentRef: string, endsAt: string, signal?: AbortSignal,
    beforeRead?: (signal: AbortSignal) => Promise<boolean>):
    Promise<Result<boolean, ClinikoBookingFailure>> {
    const id = typeof appointmentRef === "string" ? appointmentRef.match(/^cliniko:appointment:([1-9][0-9]{0,18})$/)?.[1] : undefined;
    if (!validRequest(request) || !id || instant(endsAt) !== instant(request.endsAt)) return err({ kind: "invalidQuery" });
    if (!sameScope(this.scope, request.scope)) return err({ kind: "scopeMismatch" });
    request = structuredClone(request);
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    if (stop.aborted) return err({ kind: "unavailable" });
    const limited = await untilAbort(claimClinikoBudget(this.rateBudget), stop);
    if (limited === undefined || stop.aborted) return err({ kind: "unavailable" });
    if (limited) return err(limited);
    if (beforeRead !== undefined && !await permitted(beforeRead, stop)) return err({ kind: "forbidden" });
    if (stop.aborted) return err({ kind: "unavailable" });
    try {
      const response = await untilAbort(this.fetchPort(`${this.baseUrl}/individual_appointments/${id}`, {
        method: "GET", headers: { Accept: "application/json", Authorization: this.authorization, "User-Agent": this.userAgent }, redirect: "error", signal: stop,
      }), stop);
      if (!response || stop.aborted) return err({ kind: "unavailable" });
      if (response.status === 429) await untilAbort(observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset")), stop);
      if (response.status !== 200 || stop.aborted) return err({ kind: "unavailable" });
      const parsed = await untilAbort(boundedJson(response), stop);
      if (!parsed?.ok || stop.aborted) return err({ kind: "malformed" });
      const row = record(parsed.value);
      return ok(!!row && row.id === id && this.matches(row, request) && instant(row.ends_at) === instant(endsAt) &&
        validStatus(row) && row.cancelled_at === null && row.archived_at === null && row.deleted_at === null);
    } catch { return err({ kind: "unavailable" }); }
  }

  /** A miss or mismatch is only an observation; neither permits replay of a possible POST. */
  async observe(request: ClinikoBookingRequest, signal?: AbortSignal):
    Promise<Result<ClinikoBookingObservation, ClinikoBookingFailure>> {
    if (!validRequest(request)) return err({ kind: "invalidQuery" });
    if (!sameScope(this.scope, request.scope)) return err({ kind: "scopeMismatch" });
    const observationSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    if (observationSignal.aborted) return err({ kind: "unavailable" });
    let observedAt: string;
    try { observedAt = this.clock(); }
    catch { return err({ kind: "unavailable" }); }
    if (instant(observedAt) === undefined) return err({ kind: "unavailable" });
    const seen = new Set<string>();
    const matches: Record<string, unknown>[] = [];
    let total: number | undefined;
    for (let page = 1; page <= maxPages; page += 1) {
      const limited = await untilAbort(claimClinikoBudget(this.rateBudget), observationSignal);
      if (observationSignal.aborted || limited === undefined) return err({ kind: "unavailable" });
      if (limited) return err(limited);
      const query = new URLSearchParams({ page: String(page), per_page: String(pageSize), sort: "id:asc" });
      query.append("q[]", `patient_id:=${request.patientId}`);
      let response: Response;
      try {
        const received = await untilAbort(this.fetchPort(`${this.baseUrl}/individual_appointments?${query}`, {
          method: "GET", headers: { Accept: "application/json", Authorization: this.authorization,
            "User-Agent": this.userAgent }, redirect: "error", signal: observationSignal,
        }), observationSignal);
        if (!received || observationSignal.aborted) return err({ kind: "unavailable" });
        response = received;
      } catch { return err({ kind: "unavailable" }); }
      if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
      if (response.status === 429) {
        const limited = await untilAbort(observeCliniko429(this.rateBudget,
          response.headers.get("X-RateLimit-Reset")), observationSignal);
        return err(observationSignal.aborted || !limited ? { kind: "unavailable" } : limited);
      }
      if (response.status >= 500 || response.status === 404) return err({ kind: "unavailable" });
      if (response.status !== 200) return err({ kind: "malformed" });
      const parsed = await untilAbort(boundedJson(response), observationSignal);
      if (observationSignal.aborted || !parsed) return err({ kind: "unavailable" });
      if (!parsed.ok) return parsed;
      const body = record(parsed.value);
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
          Number(body.total_entries) > maxPages * pageSize || !Array.isArray(body.individual_appointments) ||
          (total !== undefined && total !== body.total_entries)) return err({ kind: "tooManyResults" });
      total = Number(body.total_entries);
      const expected = Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize));
      if (body.individual_appointments.length !== expected) return err({ kind: "malformed" });
      for (const candidate of body.individual_appointments) {
        const row = record(candidate);
        if (!row || typeof row.id !== "string" || !idPattern.test(row.id) || seen.has(row.id) ||
            !validStatus(row) ||
            record(record(row.patient)?.links)?.self !== `${this.baseUrl}/patients/${request.patientId}`) {
          return err({ kind: "malformed" });
        }
        seen.add(row.id);
        if (row.notes === notes(request.marker)) matches.push(row);
      }
      if (seen.size === total) break;
    }
    if (observationSignal.aborted) return err({ kind: "unavailable" });
    if (seen.size !== total) return err({ kind: "tooManyResults" });
    const base = { scope: structuredClone(this.scope), observedAt };
    if (matches.length === 0) return ok({ ...base, kind: "none" });
    if (matches.length > 1) return ok({ ...base, kind: "ambiguous" });
    const row = matches[0]!;
    if (!this.matches(row, request)) return ok({ ...base, kind: "mismatch" });
    return ok({ ...base, kind: "one", appointmentRef: `cliniko:appointment:${row.id}`,
      active: !row.cancelled_at && !row.archived_at && !row.deleted_at });
  }
}
