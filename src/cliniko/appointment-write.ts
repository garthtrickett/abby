import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { claimClinikoBudget, ClinikoReadBudget, clinikoCredentialFingerprint,
  isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
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
/** Trusted host callbacks only, run after each provider-budget wait; never an agent input. */
export type ClinikoRescheduleChecks = Readonly<{
  beforeSend(signal: AbortSignal): Promise<boolean>;
  beforeRead(signal: AbortSignal): Promise<boolean>;
}>;
type BeforeRead = (signal: AbortSignal) => Promise<boolean>;

export type ClinikoRescheduleRequest = ClinikoAppointmentTarget & Readonly<{
  newStartsAt: string;
  newEndsAt: string;
  newPractitionerId?: string;
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
  if (request.newPractitionerId !== undefined && (typeof request.newPractitionerId !== "string" || !idPattern.test(request.newPractitionerId) || request.newPractitionerId === request.practitionerId)) return false;
  return oldStart !== undefined && oldEnd !== undefined &&
    newStart !== undefined && newEnd !== undefined && newEnd > newStart &&
    (newStart !== oldStart || request.newPractitionerId !== undefined) && newEnd - newStart === oldEnd - oldStart;
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

/** Stop awaiting an uncooperative budget or provider after the call has ended. */
async function untilAbort<Value>(pending: Promise<Value>, signal: AbortSignal): Promise<Value | undefined> {
  if (signal.aborted) { void pending.catch(() => undefined); return undefined; }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function deadline(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

/** Provider edge only. It cannot authorize a caller, decide fees, or make writes atomic. */
class ClinikoAppointmentWriter {
  readonly #scope: LocationScope;
  readonly #businessId: string;
  readonly #credentialFingerprint: string;
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
    this.#credentialFingerprint = clinikoCredentialFingerprint(config.apiKey);
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

  selection(): Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string }> {
    return { scope: structuredClone(this.#scope), businessId: this.#businessId,
      credentialFingerprint: this.#credentialFingerprint };
  }

  async #check(check: BeforeRead | undefined, signal: AbortSignal): Promise<Result<void, ClinikoAppointmentWriteFailure>> {
    if (signal.aborted) return err({ kind: "unavailable" });
    if (!check) return ok(undefined);
    try {
      const permitted = await untilAbort(Promise.resolve().then(() => check(signal)), signal);
      return signal.aborted || permitted === undefined ? err({ kind: "unavailable" }) :
        permitted === true ? ok(undefined) : err({ kind: "forbidden" });
    } catch { return err({ kind: "unavailable" }); }
  }

  async #read(request: ClinikoAppointmentTarget, signal: AbortSignal, beforeRead?: BeforeRead):
    Promise<Result<ClinikoAppointmentObservation, ClinikoAppointmentWriteFailure>> {
    if (signal.aborted) return err({ kind: "unavailable" });
    // Some Cliniko views require the explicit cancellation filter after a cancel.
    // Both views must fail before treating the target as unavailable.
    const path = `${this.#baseUrl}/individual_appointments/${request.appointmentId}`;
    const views = [path, `${path}?${new URLSearchParams({ "q[]": "cancelled_at:*" })}`];
    let response: Response | undefined;
    let cancelledView = false;
    for (const view of views) {
      if (signal.aborted) return err({ kind: "unavailable" });
      cancelledView = view !== path;
      const limited = await untilAbort(claimClinikoBudget(this.#rateBudget), signal);
      if (signal.aborted || limited === undefined) return err({ kind: "unavailable" });
      if (limited) return err(limited);
      const permitted = await this.#check(beforeRead, signal);
      if (!permitted.ok) return permitted;
      if (signal.aborted) return err({ kind: "unavailable" });
      try {
        const received = await untilAbort(this.#fetchPort(view, {
          method: "GET", headers: { Accept: "application/json", Authorization: this.#authorization,
            "User-Agent": this.#userAgent }, redirect: "error", signal,
        }), signal);
        if (!received || signal.aborted) return err({ kind: "unavailable" });
        response = received;
      } catch { return err({ kind: "unavailable" }); }
      if (response.status !== 404) break;
    }
    if (!response || response.status === 404) return err({ kind: "unavailable" });
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 429) {
      const limited = await untilAbort(observeCliniko429(this.#rateBudget,
        response.headers.get("X-RateLimit-Reset")), signal);
      return err(signal.aborted || !limited ? { kind: "unavailable" } : limited);
    }
    if (response.status >= 500) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    const parsed = await untilAbort(boundedJson(response), signal);
    if (!parsed || signal.aborted) return err({ kind: "unavailable" });
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
    if (signal.aborted) return err({ kind: "unavailable" });
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
  async observe(request: ClinikoAppointmentTarget, signal?: AbortSignal):
    Promise<Result<ClinikoAppointmentObservation, ClinikoAppointmentWriteFailure>> {
    if (!validTarget(request) || ("cancellationReason" in request && !validCancellation(request))) {
      return err({ kind: "invalidQuery" });
    }
    if (!sameScope(request.scope, this.#scope)) return err({ kind: "scopeMismatch" });
    return this.#read(request, deadline(signal));
  }

  /** One send attempt per appointment through this writer instance. Never retries a possibly sent PATCH. */
  async cancelOnce(request: ClinikoCancellationRequest, signal?: AbortSignal,
    beforeSend?: (signal: AbortSignal) => Promise<boolean>):
    Promise<Result<ClinikoCancellationOutcome, ClinikoAppointmentWriteFailure>> {
    if (!validCancellation(request) || (beforeSend !== undefined && typeof beforeSend !== "function")) return err({ kind: "invalidQuery" });
    if (!sameScope(request.scope, this.#scope)) return err({ kind: "scopeMismatch" });
    if (this.#attempted.has(request.appointmentId) || this.#inFlight.has(request.appointmentId)) {
      return err({ kind: "invalidQuery" });
    }
    if (this.#attempted.size >= maxAttempts) return err({ kind: "unavailable" });
    const requestSignal = deadline(signal);
    if (requestSignal.aborted) return err({ kind: "unavailable" });
    this.#inFlight.add(request.appointmentId);
    try {
      const before = await this.#read(request, requestSignal);
      if (!before.ok) return before;
      if (before.value.kind !== "active") return err({ kind: "targetChanged" });
      if (requestSignal.aborted) return err({ kind: "unavailable" });
      const limited = await untilAbort(claimClinikoBudget(this.#rateBudget), requestSignal);
      if (requestSignal.aborted || limited === undefined) return err({ kind: "unavailable" });
      if (limited) return err(limited);
      if (requestSignal.aborted) return err({ kind: "unavailable" });
      // A composed host can recheck live caller/clinic authority after all edge reads and budget waits.
      // Never let a held read or budget reservation move this check earlier than the actual PATCH.
      if (beforeSend) {
        let permitted: boolean | undefined;
        try { permitted = await untilAbort(Promise.resolve().then(() => beforeSend(requestSignal)), requestSignal); }
        catch { return err({ kind: "unavailable" }); }
        if (requestSignal.aborted || permitted === undefined) return err({ kind: "unavailable" });
        if (permitted !== true) return err({ kind: "forbidden" });
      }
      this.#attempted.add(request.appointmentId);
      let response: Response;
      try {
        const received = await untilAbort(this.#fetchPort(`${this.#baseUrl}/individual_appointments/${request.appointmentId}/cancel`, {
          method: "PATCH", headers: { Accept: "application/json", Authorization: this.#authorization,
            "Content-Type": "application/json", "User-Agent": this.#userAgent },
          body: JSON.stringify({ cancellation_note: null,
            cancellation_reason: request.cancellationReason, apply_to_repeats: false }),
          redirect: "error", signal: requestSignal,
        }), requestSignal);
        if (!received || requestSignal.aborted) return ok({ kind: "uncertain" });
        response = received;
      } catch { return ok({ kind: "uncertain" }); }
      if (response.status === 429) {
        await untilAbort(observeCliniko429(this.#rateBudget, response.headers.get("X-RateLimit-Reset")), requestSignal);
      }
      if (requestSignal.aborted) return ok({ kind: "uncertain" });
      if (response.status !== 204) return ok({ kind: "uncertain" });
      const after = await this.#read(request, requestSignal);
      return ok({ kind: !requestSignal.aborted && after.ok && after.value.kind === "cancelled"
        ? "cancelled" : "uncertain" });
    } finally { this.#inFlight.delete(request.appointmentId); }
  }

  async #conflicts(appointmentId: string, signal: AbortSignal, beforeRead?: BeforeRead): Promise<Result<boolean, ClinikoAppointmentWriteFailure>> {
    if (signal.aborted) return err({ kind: "unavailable" });
    const limited = await untilAbort(claimClinikoBudget(this.#rateBudget), signal);
    if (signal.aborted || limited === undefined) return err({ kind: "unavailable" });
    if (limited) return err(limited);
    const permitted = await this.#check(beforeRead, signal);
    if (!permitted.ok) return permitted;
    if (signal.aborted) return err({ kind: "unavailable" });
    let response: Response;
    try {
      const received = await untilAbort(this.#fetchPort(`${this.#baseUrl}/individual_appointments/${appointmentId}/conflicts`, {
        method: "GET", headers: { Accept: "application/json", Authorization: this.#authorization,
          "User-Agent": this.#userAgent }, redirect: "error", signal,
      }), signal);
      if (!received || signal.aborted) return err({ kind: "unavailable" });
      response = received;
    } catch { return err({ kind: "unavailable" }); }
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 429) {
      const limited = await untilAbort(observeCliniko429(this.#rateBudget,
        response.headers.get("X-RateLimit-Reset")), signal);
      return err(signal.aborted || !limited ? { kind: "unavailable" } : limited);
    }
    if (response.status >= 500 || response.status === 404) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    const parsed = await untilAbort(boundedJson(response), signal);
    if (!parsed || signal.aborted) return err({ kind: "unavailable" });
    if (!parsed.ok) return parsed;
    const exists = record(record(parsed.value)?.conflicts)?.exist;
    return typeof exists === "boolean" ? ok(exists) : err({ kind: "malformed" });
  }

  /** A fresh observation is current state, not proof that this writer caused the move. */
  async #observeReschedule(request: ClinikoRescheduleRequest, signal: AbortSignal, beforeRead?: BeforeRead):
    Promise<Result<ClinikoRescheduleObservation, ClinikoAppointmentWriteFailure>> {
    if (signal.aborted) return err({ kind: "unavailable" });
    if (!validReschedule(request)) return err({ kind: "invalidQuery" });
    if (!sameScope(request.scope, this.#scope)) return err({ kind: "scopeMismatch" });
    const moved = await this.#read({ ...request, practitionerId: request.newPractitionerId ?? request.practitionerId, startsAt: request.newStartsAt, endsAt: request.newEndsAt }, signal, beforeRead);
    if (!moved.ok) return moved;
    if (signal.aborted) return err({ kind: "unavailable" });
    if (moved.value.kind === "active") {
      const conflicts = await this.#conflicts(request.appointmentId, signal, beforeRead);
      if (!conflicts.ok) return conflicts;
      if (signal.aborted) return err({ kind: "unavailable" });
      return ok({ kind: conflicts.value ? "newWithConflict" : "new", observedAt: moved.value.observedAt });
    }
    if (moved.value.kind === "cancelled") return ok({ kind: "cancelled", observedAt: moved.value.observedAt });
    const old = await this.#read(request, signal, beforeRead);
    if (!old.ok) return old;
    if (signal.aborted) return err({ kind: "unavailable" });
    return ok({ kind: old.value.kind === "active" ? "old" :
      old.value.kind === "cancelled" ? "cancelled" : "changed", observedAt: old.value.observedAt });
  }

  async observeReschedule(incoming: ClinikoRescheduleRequest, signal?: AbortSignal, beforeRead?: BeforeRead):
    Promise<Result<ClinikoRescheduleObservation, ClinikoAppointmentWriteFailure>> {
    if (!validReschedule(incoming) || (beforeRead !== undefined && typeof beforeRead !== "function")) return err({ kind: "invalidQuery" });
    const request = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    return this.#observeReschedule(request, deadline(signal), beforeRead);
  }

  /** One in-place PATCH per appointment through this writer instance; no cancel-then-create or replay. */
  async rescheduleOnce(incoming: ClinikoRescheduleRequest, signal?: AbortSignal, checks?: ClinikoRescheduleChecks):
    Promise<Result<ClinikoRescheduleOutcome, ClinikoAppointmentWriteFailure>> {
    if (!validReschedule(incoming) || (checks !== undefined && (!checks || typeof checks.beforeSend !== "function" || typeof checks.beforeRead !== "function"))) return err({ kind: "invalidQuery" });
    if (incoming.newPractitionerId !== undefined && checks === undefined) return err({ kind: "forbidden" });
    const request = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
    const beforeSend = checks?.beforeSend, beforeRead = checks?.beforeRead;
    if (!sameScope(request.scope, this.#scope)) return err({ kind: "scopeMismatch" });
    if (this.#attempted.has(request.appointmentId) || this.#inFlight.has(request.appointmentId)) {
      return err({ kind: "invalidQuery" });
    }
    if (this.#attempted.size >= maxAttempts) return err({ kind: "unavailable" });
    const requestSignal = deadline(signal);
    if (requestSignal.aborted) return err({ kind: "unavailable" });
    this.#inFlight.add(request.appointmentId);
    try {
      const before = await this.#read(request, requestSignal, beforeRead);
      if (!before.ok) return before;
      if (before.value.kind !== "active") return err({ kind: "targetChanged" });
      if (requestSignal.aborted) return err({ kind: "unavailable" });
      const limited = await untilAbort(claimClinikoBudget(this.#rateBudget), requestSignal);
      if (requestSignal.aborted || limited === undefined) return err({ kind: "unavailable" });
      if (limited) return err(limited);
      if (requestSignal.aborted) return err({ kind: "unavailable" });
      const permitted = await this.#check(beforeSend, requestSignal);
      if (!permitted.ok) return permitted;
      if (requestSignal.aborted) return err({ kind: "unavailable" });
      this.#attempted.add(request.appointmentId);
      let response: Response;
      try {
        const received = await untilAbort(this.#fetchPort(`${this.#baseUrl}/individual_appointments/${request.appointmentId}`, {
          method: "PATCH", headers: { Accept: "application/json", Authorization: this.#authorization,
            "Content-Type": "application/json", "User-Agent": this.#userAgent },
          body: JSON.stringify({ starts_at: request.newStartsAt, ends_at: null,
            ...(request.newPractitionerId ? { practitioner_id: request.newPractitionerId } : {}) }),
          redirect: "error", signal: requestSignal,
        }), requestSignal);
        if (!received || requestSignal.aborted) return ok({ kind: "uncertain" });
        response = received;
      } catch { return ok({ kind: "uncertain" }); }
      if (response.status === 429) {
        await untilAbort(observeCliniko429(this.#rateBudget, response.headers.get("X-RateLimit-Reset")), requestSignal);
      }
      if (requestSignal.aborted) return ok({ kind: "uncertain" });
      if (response.status !== 200) return ok({ kind: "uncertain" });
      // The PATCH response alone cannot prove the appointment's current state or lack of overlap.
      const after = await this.#observeReschedule(request, requestSignal, beforeRead);
      return ok({ kind: requestSignal.aborted || !after.ok ? "uncertain" : after.value.kind === "new" ? "moved" :
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

  selection(): Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string }> {
    return this.#inner.selection();
  }

  observe(request: ClinikoCancellationRequest, signal?: AbortSignal):
    Promise<Result<ClinikoAppointmentObservation, ClinikoAppointmentWriteFailure>> {
    return this.#inner.observe(request, signal);
  }

  cancelOnce(request: ClinikoCancellationRequest, signal?: AbortSignal,
    beforeSend?: (signal: AbortSignal) => Promise<boolean>):
    Promise<Result<ClinikoCancellationOutcome, ClinikoAppointmentWriteFailure>> {
    return this.#inner.cancelOnce(request, signal, beforeSend);
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

  selection(): Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string }> {
    return this.#inner.selection();
  }

  observeReschedule(request: ClinikoRescheduleRequest, signal?: AbortSignal, beforeRead?: BeforeRead):
    Promise<Result<ClinikoRescheduleObservation, ClinikoAppointmentWriteFailure>> {
    return this.#inner.observeReschedule(request, signal, beforeRead);
  }

  rescheduleOnce(request: ClinikoRescheduleRequest, signal?: AbortSignal, checks?: ClinikoRescheduleChecks):
    Promise<Result<ClinikoRescheduleOutcome, ClinikoAppointmentWriteFailure>> {
    return this.#inner.rescheduleOnce(request, signal, checks);
  }
}
