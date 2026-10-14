import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { boundedClinikoJson } from "./bounded-json.ts";
import { claimClinikoBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

export type ClinikoAttendanceConfig = Readonly<{
  scope: LocationScope; apiKey: string; contactEmail: string; businessId: string;
  practitionerId: string; appointmentTypeId: string; rateBudget: ClinikoRequestBudget;
}>;
/** Constructed privately by the host after resolving patient, session, terms,
 * membership/payment and separately played consent. No model submits native IDs. */
export type ClinikoAttendanceRequest = Readonly<{
  scope: LocationScope; patientId: string; sessionId: string; actionId: string;
}> & (Readonly<{ kind: "book" }> | Readonly<{ kind: "cancel"; attendeeId: string; cancellationReason: 10 | 20 | 30 | 40 | 50 | 60 }>);
export type ClinikoAttendanceFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidQuery" | "forbidden" | "unavailable" | "rateLimited" | "malformed" | "tooManyResults";
  resetAt?: string;
}>;
export type ClinikoAttendanceWrite = Readonly<{ kind: "accepted"; attendeeRef: string }> | Readonly<{ kind: "uncertain" }>;
/** Trusted host check, after every final account-budget wait. It must recheck
 * exact patient/session selection, independent class authority, current
 * capacity/duplicates, fee/member policy, played consent and owned review. */
export type ClinikoAttendancePermit = (signal: AbortSignal) => Promise<boolean>;
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const scopeValid = (v: unknown): v is LocationScope => {
  const row = object(v); return !!row && [row.tenantId, row.clinicId, row.locationId].every(part => typeof part === "string" && !!part.trim() && part.length <= 256);
};
const sameScope = (a: LocationScope, b: LocationScope) => a.tenantId === b.tenantId && a.clinicId === b.clinicId && a.locationId === b.locationId;
const date = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return false;
  const [year, month, day] = v.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === v.slice(0, 10) && Number.isFinite(Date.parse(v));
};
const validRequest = (v: unknown): v is ClinikoAttendanceRequest => {
  const row = object(v); return !!row && scopeValid(row.scope) && id(row.patientId) && id(row.sessionId) && uuid(row.actionId) &&
    (row.kind === "book" || row.kind === "cancel" && id(row.attendeeId) && [10, 20, 30, 40, 50, 60].includes(Number(row.cancellationReason)) && typeof row.cancellationReason === "number");
};
const notes = (actionId: string) => `Abby attendance ${actionId}`;
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let stop = () => {};
  const aborted = new Promise<undefined>(resolve => { stop = () => resolve(undefined); signal.addEventListener("abort", stop); if (signal.aborted) stop(); });
  try { return await Promise.race([work, aborted]); } finally { signal.removeEventListener("abort", stop); }
}
async function permitted(check: ClinikoAttendancePermit, signal: AbortSignal): Promise<boolean> {
  try { return typeof check === "function" && await untilAbort(Promise.resolve().then(() => check(signal)), signal) === true && !signal.aborted; }
  catch { return false; }
}

/** Native attendee writes only: never modify a shared class, cancel all repeats,
 * adjust credits, issue refunds or implement a move implicitly. Accepted is a
 * provider acknowledgement, not a caller confirmation. The host must inspect
 * the exact record and current class capacity before declaring completion. */
export class ClinikoClassAttendanceWriter {
  readonly #config: ClinikoAttendanceConfig;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #attempted = new Set<string>();
  private constructor(config: ClinikoAttendanceConfig, shard: string, fetchPort: typeof fetch) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); this.#base = `https://api.${shard}.cliniko.com/v1`; this.#fetch = fetchPort;
  }
  static create(config: ClinikoAttendanceConfig, fetchPort: typeof fetch = fetch): Result<ClinikoClassAttendanceWriter, ClinikoAttendanceFailure> {
    const shard = typeof config?.apiKey === "string" ? /-([a-z]{2}[0-9]{1,2})$/.exec(config.apiKey)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) || !scopeValid(config.scope) ||
      ![config.businessId, config.practitionerId, config.appointmentTypeId].every(id) || typeof config.contactEmail !== "string" ||
      config.contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) ||
      !isClinikoRequestBudget(config.rateBudget) || typeof fetchPort !== "function") return err({ kind: "invalidConfig" });
    return ok(new ClinikoClassAttendanceWriter(config, shard, fetchPort));
  }
  selection() { const c = this.#config; return { scope: { ...c.scope }, businessId: c.businessId, practitionerId: c.practitionerId,
    appointmentTypeId: c.appointmentTypeId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey) }; }
  #headers() { return { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`,
    "Content-Type": "application/json", "User-Agent": `Abby (${this.#config.contactEmail})` }; }
  #matches(row: Record<string, unknown>, request: ClinikoAttendanceRequest): boolean {
    const link = (v: unknown) => object(object(v)?.links)?.self;
    return id(row.id) && link(row) === `${this.#base}/attendees/${row.id}` && link(row.patient) === `${this.#base}/patients/${request.patientId}` &&
      link(row.booking) === `${this.#base}/bookings/${request.sessionId}` && row.archived_at === null && row.deleted_at === null &&
      (request.kind === "book" ? row.cancelled_at === null && row.notes === notes(request.actionId) :
        row.id === request.attendeeId && date(row.cancelled_at) && row.cancellation_reason === request.cancellationReason);
  }
  async executeOnce(input: ClinikoAttendanceRequest, signal: AbortSignal, beforeSend: ClinikoAttendancePermit): Promise<Result<ClinikoAttendanceWrite, ClinikoAttendanceFailure>> {
    if (!validRequest(input)) return err({ kind: "invalidQuery" });
    if (!sameScope(input.scope, this.#config.scope)) return err({ kind: "scopeMismatch" });
    const request = structuredClone(input);
    if (!(signal instanceof AbortSignal) || signal.aborted) return err({ kind: "unavailable" });
    if (typeof beforeSend !== "function") return err({ kind: "forbidden" });
    if (this.#attempted.has(request.actionId)) return err({ kind: "invalidQuery" });
    if (this.#attempted.size >= 10_000) return err({ kind: "unavailable" });
    this.#attempted.add(request.actionId);
    const stop = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const limited = await untilAbort(claimClinikoBudget(this.#config.rateBudget), stop);
    if (limited === undefined || limited || stop.aborted || !await permitted(beforeSend, stop)) {
      // No possible mutation; release only this pre-send attempt.
      this.#attempted.delete(request.actionId);
      return err(limited ?? { kind: stop.aborted ? "unavailable" : "forbidden" });
    }
    // There is no await between this last abort check and provider invocation.
    if (stop.aborted) { this.#attempted.delete(request.actionId); return err({ kind: "unavailable" }); }
    let response: Response | undefined;
    try {
      response = await untilAbort(this.#fetch(`${this.#base}${request.kind === "book" ? "/attendees" : `/attendees/${request.attendeeId}/cancel`}`, {
        method: request.kind === "book" ? "POST" : "PATCH", redirect: "error", signal: stop, headers: this.#headers(),
        body: JSON.stringify(request.kind === "book" ? { booking_id: request.sessionId, patient_id: request.patientId, notes: notes(request.actionId) } :
          { cancellation_reason: request.cancellationReason, apply_to_repeats: false }),
      }), stop);
    } catch { return ok({ kind: "uncertain" }); }
    if (!response || stop.aborted) return ok({ kind: "uncertain" });
    if (response.status === 429) await untilAbort(observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset")), stop);
    if (request.kind === "cancel") return response.status === 204 && !stop.aborted ? ok({ kind: "accepted", attendeeRef: `cliniko:attendee:${request.attendeeId}` }) : ok({ kind: "uncertain" });
    if (response.status !== 201) return ok({ kind: "uncertain" });
    const body = await untilAbort(boundedClinikoJson(response), stop), row = body?.ok ? object(body.value) : undefined;
    return row && !stop.aborted && this.#matches(row, request) ? ok({ kind: "accepted", attendeeRef: `cliniko:attendee:${row.id}` }) : ok({ kind: "uncertain" });
  }
  /** Exact guarded record inspection after clear acknowledgement. It grants no
   * automatic retry, refund or upgrade of an earlier uncertain call outcome. */
  async inspect(input: ClinikoAttendanceRequest, attendeeRef: string, signal: AbortSignal, beforeRead: ClinikoAttendancePermit): Promise<Result<boolean, ClinikoAttendanceFailure>> {
    if (!validRequest(input) || !(signal instanceof AbortSignal)) return err({ kind: "invalidQuery" });
    if (!sameScope(input.scope, this.#config.scope)) return err({ kind: "scopeMismatch" });
    const request = structuredClone(input), selected = /^cliniko:attendee:([1-9][0-9]{0,18})$/.exec(attendeeRef)?.[1];
    if (!selected || request.kind === "cancel" && selected !== request.attendeeId) return err({ kind: "invalidQuery" });
    const stop = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const limited = await untilAbort(claimClinikoBudget(this.#config.rateBudget), stop);
    if (limited === undefined || stop.aborted) return err({ kind: "unavailable" });
    if (limited) return err(limited);
    if (!await permitted(beforeRead, stop)) return err({ kind: "forbidden" });
    try {
      const response = await untilAbort(this.#fetch(`${this.#base}/attendees/${selected}`, { method: "GET", redirect: "error", signal: stop, headers: this.#headers() }), stop);
      if (!response || stop.aborted) return err({ kind: "unavailable" });
      if (response.status === 429) return err(await observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset")));
      if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
      if (response.status !== 200) return err({ kind: "unavailable" });
      const parsed = await untilAbort(boundedClinikoJson(response), stop);
      if (!parsed?.ok || stop.aborted) return err({ kind: "malformed" });
      if (!await permitted(beforeRead, stop)) return err({ kind: "forbidden" });
      const row = object(parsed.value); return ok(!!row && row.id === selected && this.#matches(row, request));
    } catch { return err({ kind: "unavailable" }); }
  }
}
