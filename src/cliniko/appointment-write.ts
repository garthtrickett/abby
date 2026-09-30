import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { claimClinikoBudget, ClinikoReadBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

export type ClinikoAppointmentWriteConfig = Readonly<{
  scope: LocationScope;
  apiKey: string;
  contactEmail: string;
  businessId: string;
  rateBudget?: ClinikoRequestBudget;
}>;

/** The caller-facing host must bind a verified patient, exact selected target, policy and confirmation first. */
export type ClinikoAppointmentTarget = Readonly<{
  scope: LocationScope;
  patientId: string;
  appointmentId: string;
  practitionerId: string;
  appointmentTypeId: string;
  startsAt: string;
  endsAt: string;
}>;
export type ClinikoCancellationRequest = ClinikoAppointmentTarget & Readonly<{
  cancellationReason: 10 | 20 | 30 | 40 | 50 | 60;
}>;
export type ClinikoRescheduleRequest = ClinikoAppointmentTarget & Readonly<{
  newStartsAt: string;
  newEndsAt: string;
}>;

export type ClinikoAppointmentWriteFailure = Readonly<{
  kind: "invalidConfig" | "invalidQuery" | "scopeMismatch" | "targetChanged" |
    "forbidden" | "rateLimited" | "unavailable" | "malformed";
  resetAt?: string;
}>;
export type ClinikoAppointmentObservation = Readonly<{
  kind: "active" | "cancelled" | "changed";
  observedAt: string;
}>;
export type ClinikoCancellationOutcome = Readonly<{ kind: "cancelled" | "uncertain" }>;
export type ClinikoRescheduleOutcome = Readonly<{ kind: "moved" | "movedWithConflict" | "uncertain" }>;
export type ClinikoRescheduleObservation = Readonly<{
  kind: "old" | "new" | "newWithConflict" | "changed" | "cancelled";
  observedAt: string;
}>;

const idPattern = /^[1-9][0-9]{0,18}$/;
const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const maxBodyBytes = 1_000_000;
const maxAttempts = 10_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function validScope(value: unknown): value is LocationScope {
  const scope = record(value);
  return !!scope && [scope.tenantId, scope.clinicId, scope.locationId]
    .every(part => typeof part === "string" && part.trim().length > 0 && part.length <= 256);
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

function instant(value: unknown): number | undefined {
  if (typeof value !== "string" || !instantPattern.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validTarget(value: unknown): value is ClinikoAppointmentTarget {
  const request = record(value);
  return !!request && validScope(request.scope) &&
    [request.patientId, request.appointmentId, request.practitionerId, request.appointmentTypeId]
      .every(id => typeof id === "string" && idPattern.test(id)) &&
    instant(request.startsAt) !== undefined && instant(request.endsAt) !== undefined &&
    instant(request.endsAt)! > instant(request.startsAt)!;
}

function validCancellation(value: unknown): value is ClinikoCancellationRequest {
  const request = record(value);
  return validTarget(value) && !!request &&
    [10, 20, 30, 40, 50, 60].includes(request.cancellationReason as number);
}

function validReschedule(value: unknown): value is ClinikoRescheduleRequest {
  const request = record(value);
  if (!validTarget(value) || !request) return false;
  const oldStart = instant(request.startsAt);
  const oldEnd = instant(request.endsAt);
  const newStart = instant(request.newStartsAt);
  const newEnd = instant(request.newEndsAt);
  return oldStart !== undefined && oldEnd !== undefined &&
    newStart !== undefined && newEnd !== undefined && newEnd > newStart &&
    newStart !== oldStart && newEnd - newStart === oldEnd - oldStart;
}

async function boundedJson(response: Response): Promise<Result<unknown, ClinikoAppointmentWriteFailure>> {
  if (!response.body) return err({ kind: "malformed" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBodyBytes) { await reader.cancel(); return err({ kind: "malformed" }); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return ok(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } catch { return err({ kind: "malformed" }); }
  finally { reader.releaseLock(); }
}

/** Provider edge only. It cannot authorize a caller, decide fees, or make writes atomic. */
class ClinikoAppointmentWriter {
  readonly #scope: LocationScope;
  readonly #businessId: string;
  readonly #baseUrl: string;
  readonly #authorization: string;
  readonly #userAgent: string;
  readonly #rateBudget: ClinikoRequestBudget;
  readonly #fetchPort: typeof fetch;
  readonly #clock: () => string;
  readonly #inFlight = new Set<string>();
  readonly #attempted = new Set<string>();

  private constructor(config: ClinikoAppointmentWriteConfig, shard: string, fetchPort: typeof fetch,
                      clock: () => string) {
    this.#scope = structuredClone(config.scope);
    this.#businessId = config.businessId;
    this.#baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.#authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.#userAgent = `Abby (${config.contactEmail})`;
    this.#rateBudget = config.rateBudget ?? new ClinikoReadBudget();
    this.#fetchPort = fetchPort;
    this.#clock = clock;
  }

  static create(config: ClinikoAppointmentWriteConfig, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()):
    Result<ClinikoAppointmentWriter, ClinikoAppointmentWriteFailure> {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
        !validScope(config.scope) || typeof config.contactEmail !== "string" ||
        config.contactEmail.length > 254 || !emailPattern.test(config.contactEmail) ||
        typeof config.businessId !== "string" || !idPattern.test(config.businessId) ||
        typeof fetchPort !== "function" || typeof clock !== "function" ||
        (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget))) {
      return err({ kind: "invalidConfig" });
    }
    return ok(new ClinikoAppointmentWriter(config, shard, fetchPort, clock));
  }

  async #read(request: ClinikoAppointmentTarget):
    Promise<Result<ClinikoAppointmentObservation, ClinikoAppointmentWriteFailure>> {
    // Some Cliniko views require the explicit cancellation filter after a cancel.
    // Both views must fail before treating the target as unavailable.
    const path = `${this.#baseUrl}/individual_appointments/${request.appointmentId}`;
    const views = [path, `${path}?${new URLSearchParams({ "q[]": "cancelled_at:*" })}`];
    let response: Response | undefined;
    let cancelledView = false;
    for (const view of views) {
      cancelledView = view !== path;
      const limited = await claimClinikoBudget(this.#rateBudget);
      if (limited) return err(limited);
      try {
        response = await this.#fetchPort(view, {
          method: "GET", headers: { Accept: "application/json", Authorization: this.#authorization,
            "User-Agent": this.#userAgent }, redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch { return err({ kind: "unavailable" }); }
      if (response.status !== 404) break;
    }
    if (!response || response.status === 404) return err({ kind: "unavailable" });
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 429) return err(await observeCliniko429(this.#rateBudget, response.headers.get("X-RateLimit-Reset")));
    if (response.status >= 500) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    const parsed = await boundedJson(response);
    if (!parsed.ok) return parsed;
    const row = record(parsed.value);
    const link = (name: string) => record(record(row?.[name])?.links)?.self;
    if (!row || row.id !== request.appointmentId ||
        [row.cancelled_at, row.archived_at, row.deleted_at]
          .some(value => value !== null && instant(value) === undefined) ||
        instant(row.starts_at) === undefined || instant(row.ends_at) === undefined ||
        ["patient", "business", "practitioner", "appointment_type"].some(name => typeof link(name) !== "string")) {
      return err({ kind: "malformed" });
    }
    if (cancelledView && !row.cancelled_at) return err({ kind: "malformed" });
    let observedAt: string;
    try { observedAt = this.#clock(); }
    catch { return err({ kind: "unavailable" }); }
    if (instant(observedAt) === undefined) return err({ kind: "unavailable" });
    if (link("patient") !== `${this.#baseUrl}/patients/${request.patientId}` ||
        link("business") !== `${this.#baseUrl}/businesses/${this.#businessId}` ||
        link("practitioner") !== `${this.#baseUrl}/practitioners/${request.practitionerId}` ||
        link("appointment_type") !== `${this.#baseUrl}/appointment_types/${request.appointmentTypeId}` ||
        instant(row.starts_at) !== instant(request.startsAt) ||
        instant(row.ends_at) !== instant(request.endsAt) || row.archived_at || row.deleted_at) {
      return ok({ kind: "changed", observedAt });
    }
    return ok({ kind: row.cancelled_at ? "cancelled" : "active", observedAt });
  }

  /** A caller must not infer a missed PATCH from an active observation. */
  async observe(request: ClinikoAppointmentTarget):
    Promise<Result<ClinikoAppointmentObservation, ClinikoAppointmentWriteFailure>> {
    if (!validTarget(request) || ("cancellationReason" in request && !validCancellation(request))) {
      return err({ kind: "invalidQuery" });
    }
    if (!sameScope(request.scope, this.#scope)) return err({ kind: "scopeMismatch" });
    return this.#read(request);
  }

  /** One send attempt per appointment through this writer instance. Never retries a possibly sent PATCH. */
  async cancelOnce(request: ClinikoCancellationRequest):
    Promise<Result<ClinikoCancellationOutcome, ClinikoAppointmentWriteFailure>> {
    if (!validCancellation(request)) return err({ kind: "invalidQuery" });
    if (!sameScope(request.scope, this.#scope)) return err({ kind: "scopeMismatch" });
    if (this.#attempted.has(request.appointmentId) || this.#inFlight.has(request.appointmentId)) {
      return err({ kind: "invalidQuery" });
    }
    if (this.#attempted.size >= maxAttempts) return err({ kind: "unavailable" });
    this.#inFlight.add(request.appointmentId);
    try {
      const before = await this.#read(request);
      if (!before.ok) return before;
      if (before.value.kind !== "active") return err({ kind: "targetChanged" });
      const limited = await claimClinikoBudget(this.#rateBudget);
      if (limited) return err(limited);
      this.#attempted.add(request.appointmentId);
      let response: Response;
      try {
        response = await this.#fetchPort(`${this.#baseUrl}/individual_appointments/${request.appointmentId}/cancel`, {
          method: "PATCH", headers: { Accept: "application/json", Authorization: this.#authorization,
            "Content-Type": "application/json", "User-Agent": this.#userAgent },
          body: JSON.stringify({ cancellation_note: null,
            cancellation_reason: request.cancellationReason, apply_to_repeats: false }),
          redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch { return ok({ kind: "uncertain" }); }
      if (response.status === 429) await observeCliniko429(this.#rateBudget, response.headers.get("X-RateLimit-Reset"));
      if (response.status !== 204) return ok({ kind: "uncertain" });
      const after = await this.#read(request);
      return ok({ kind: after.ok && after.value.kind === "cancelled" ? "cancelled" : "uncertain" });
    } finally { this.#inFlight.delete(request.appointmentId); }
  }

  async #conflicts(appointmentId: string): Promise<Result<boolean, ClinikoAppointmentWriteFailure>> {
    const limited = await claimClinikoBudget(this.#rateBudget);
    if (limited) return err(limited);
    let response: Response;
    try {
      response = await this.#fetchPort(`${this.#baseUrl}/individual_appointments/${appointmentId}/conflicts`, {
        method: "GET", headers: { Accept: "application/json", Authorization: this.#authorization,
          "User-Agent": this.#userAgent }, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { return err({ kind: "unavailable" }); }
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 429) return err(await observeCliniko429(this.#rateBudget, response.headers.get("X-RateLimit-Reset")));
    if (response.status >= 500 || response.status === 404) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    const parsed = await boundedJson(response);
    if (!parsed.ok) return parsed;
    const exists = record(record(parsed.value)?.conflicts)?.exist;
    return typeof exists === "boolean" ? ok(exists) : err({ kind: "malformed" });
  }

  /** A fresh observation is current state, not proof that this writer caused the move. */
  async observeReschedule(request: ClinikoRescheduleRequest):
    Promise<Result<ClinikoRescheduleObservation, ClinikoAppointmentWriteFailure>> {
    if (!validReschedule(request)) return err({ kind: "invalidQuery" });
    if (!sameScope(request.scope, this.#scope)) return err({ kind: "scopeMismatch" });
    const moved = await this.#read({ ...request, startsAt: request.newStartsAt, endsAt: request.newEndsAt });
    if (!moved.ok) return moved;
    if (moved.value.kind === "active") {
      const conflicts = await this.#conflicts(request.appointmentId);
      if (!conflicts.ok) return conflicts;
      return ok({ kind: conflicts.value ? "newWithConflict" : "new", observedAt: moved.value.observedAt });
    }
    if (moved.value.kind === "cancelled") return ok({ kind: "cancelled", observedAt: moved.value.observedAt });
    const old = await this.#read(request);
    if (!old.ok) return old;
    return ok({ kind: old.value.kind === "active" ? "old" :
      old.value.kind === "cancelled" ? "cancelled" : "changed", observedAt: old.value.observedAt });
  }

  /** One in-place PATCH per appointment through this writer instance; no cancel-then-create or replay. */
  async rescheduleOnce(request: ClinikoRescheduleRequest):
    Promise<Result<ClinikoRescheduleOutcome, ClinikoAppointmentWriteFailure>> {
    if (!validReschedule(request)) return err({ kind: "invalidQuery" });
    if (!sameScope(request.scope, this.#scope)) return err({ kind: "scopeMismatch" });
    if (this.#attempted.has(request.appointmentId) || this.#inFlight.has(request.appointmentId)) {
      return err({ kind: "invalidQuery" });
    }
    if (this.#attempted.size >= maxAttempts) return err({ kind: "unavailable" });
    this.#inFlight.add(request.appointmentId);
    try {
      const before = await this.#read(request);
      if (!before.ok) return before;
      if (before.value.kind !== "active") return err({ kind: "targetChanged" });
      const limited = await claimClinikoBudget(this.#rateBudget);
      if (limited) return err(limited);
      this.#attempted.add(request.appointmentId);
      let response: Response;
      try {
        response = await this.#fetchPort(`${this.#baseUrl}/individual_appointments/${request.appointmentId}`, {
          method: "PATCH", headers: { Accept: "application/json", Authorization: this.#authorization,
            "Content-Type": "application/json", "User-Agent": this.#userAgent },
          body: JSON.stringify({ starts_at: request.newStartsAt, ends_at: null }),
          redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch { return ok({ kind: "uncertain" }); }
      if (response.status === 429) await observeCliniko429(this.#rateBudget, response.headers.get("X-RateLimit-Reset"));
      if (response.status !== 200) return ok({ kind: "uncertain" });
      // The PATCH response alone cannot prove the appointment's current state or lack of overlap.
      const after = await this.observeReschedule(request);
      return ok({ kind: !after.ok ? "uncertain" : after.value.kind === "new" ? "moved" :
        after.value.kind === "newWithConflict" ? "movedWithConflict" : "uncertain" });
    } finally { this.#inFlight.delete(request.appointmentId); }
  }
}

/** Cancellation exposes only cancellation operations to a composed host. */
export class ClinikoCancellationWriter {
  readonly #inner: ClinikoAppointmentWriter;
  private constructor(inner: ClinikoAppointmentWriter) { this.#inner = inner; }

  static create(config: ClinikoAppointmentWriteConfig, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()):
    Result<ClinikoCancellationWriter, ClinikoAppointmentWriteFailure> {
    const created = ClinikoAppointmentWriter.create(config, fetchPort, clock);
    return created.ok ? ok(new ClinikoCancellationWriter(created.value)) : created;
  }

  observe(request: ClinikoCancellationRequest):
    Promise<Result<ClinikoAppointmentObservation, ClinikoAppointmentWriteFailure>> {
    return this.#inner.observe(request);
  }

  cancelOnce(request: ClinikoCancellationRequest):
    Promise<Result<ClinikoCancellationOutcome, ClinikoAppointmentWriteFailure>> {
    return this.#inner.cancelOnce(request);
  }
}

/** Rescheduling exposes only the single in-place move and current-state observation. */
export class ClinikoRescheduleWriter {
  readonly #inner: ClinikoAppointmentWriter;
  private constructor(inner: ClinikoAppointmentWriter) { this.#inner = inner; }

  static create(config: ClinikoAppointmentWriteConfig, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()):
    Result<ClinikoRescheduleWriter, ClinikoAppointmentWriteFailure> {
    const created = ClinikoAppointmentWriter.create(config, fetchPort, clock);
    return created.ok ? ok(new ClinikoRescheduleWriter(created.value)) : created;
  }

  observeReschedule(request: ClinikoRescheduleRequest):
    Promise<Result<ClinikoRescheduleObservation, ClinikoAppointmentWriteFailure>> {
    return this.#inner.observeReschedule(request);
  }

  rescheduleOnce(request: ClinikoRescheduleRequest):
    Promise<Result<ClinikoRescheduleOutcome, ClinikoAppointmentWriteFailure>> {
    return this.#inner.rescheduleOnce(request);
  }
}
