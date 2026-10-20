import { err, ok } from "../core/model.ts";
import type { AvailabilityRead, AvailabilityReadFailure, LocationScope, Result } from "../core/model.ts";
import { claimClinikoBudget, ClinikoReadBudget, clinikoCredentialFingerprint,
  isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

export type ClinikoAvailabilityConfig = Readonly<{
  scope: LocationScope;
  apiKey: string;
  contactEmail: string;
  businessId: string;
  practitionerId: string;
  appointmentTypeId: string;
  rateBudget?: ClinikoRequestBudget;
  /** Fixed-code operational signal for a failed provider request; never receives patient data. */
  onProviderUnavailable?: () => void | Promise<void>;
}>;

export type ClinikoAvailabilityFailure = AvailabilityReadFailure;

export type ClinikoAvailability =
  | Extract<AvailabilityRead, { kind: "notEligible" }>
  | (Extract<AvailabilityRead, { kind: "times" }> & Readonly<{
    businessRef: string;
    practitionerRef: string;
    appointmentTypeRef: string;
  }>);

const maxBodyBytes = 1_000_000;
const perPage = 100;
const maxPages = 10;
export const availabilityReadDeadlineMs = 15_000;

function validId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function spokenName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 120 &&
    value.trim() === value && /^[\p{L}\p{M}\p{N} .,'()&/-]+$/u.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function settleBeforeAbort<T>(work: Promise<T>, signal: AbortSignal, unavailable: T): Promise<T> {
  if (signal.aborted) return unavailable;
  let onAbort = () => {};
  const aborted = new Promise<T>(resolve => {
    onAbort = () => resolve(unavailable);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function sameScope(left: LocationScope, right: LocationScope): boolean {
  return left.tenantId === right.tenantId && left.clinicId === right.clinicId && left.locationId === right.locationId;
}

async function boundedJson(response: Response): Promise<Result<unknown, ClinikoAvailabilityFailure>> {
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

export class ClinikoAvailabilityReader {
  private readonly scope: LocationScope;
  private readonly businessId: string;
  private readonly practitionerId: string;
  private readonly appointmentTypeId: string;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly fetchPort: typeof fetch;
  private readonly observedClock: () => string;
  private readonly rateBudget: ClinikoRequestBudget;
  private readonly credentialHash: string;
  private readonly onProviderUnavailable: (() => void | Promise<void>) | undefined;

  private constructor(config: ClinikoAvailabilityConfig, shard: string, fetchPort: typeof fetch, observedClock: () => string) {
    this.scope = structuredClone(config.scope);
    this.businessId = config.businessId;
    this.practitionerId = config.practitionerId;
    this.appointmentTypeId = config.appointmentTypeId;
    this.baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.fetchPort = fetchPort;
    this.observedClock = observedClock;
    this.rateBudget = config.rateBudget ?? new ClinikoReadBudget();
    this.credentialHash = clinikoCredentialFingerprint(config.apiKey);
    this.onProviderUnavailable = config.onProviderUnavailable;
  }

  static create(config: ClinikoAvailabilityConfig, fetchPort: typeof fetch = fetch, observedClock: () => string = () => new Date().toISOString()): Result<ClinikoAvailabilityReader, ClinikoAvailabilityFailure> {
    const shard = config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1];
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) ||
        !config.scope.tenantId || !config.scope.clinicId || !config.scope.locationId ||
        !validId(config.businessId) || !validId(config.practitionerId) || !validId(config.appointmentTypeId) ||
        (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget)) ||
        (config.onProviderUnavailable !== undefined && typeof config.onProviderUnavailable !== "function")) {
      return err({ kind: "invalidConfig" });
    }
    return ok(new ClinikoAvailabilityReader(config, shard, fetchPort, observedClock));
  }

  /** Route validation can prove clinic ownership before opening a call listener. */
  matchesScope(scope: LocationScope): boolean {
    return sameScope(this.scope, scope);
  }

  matchesSelection(scope: LocationScope, selected: Readonly<{
    businessId: string; practitionerId: string; appointmentTypeId: string; credentialFingerprint: string;
  }>): boolean {
    return !!selected && sameScope(this.scope, scope) && selected.businessId === this.businessId &&
      selected.practitionerId === this.practitionerId && selected.appointmentTypeId === this.appointmentTypeId &&
      selected.credentialFingerprint === this.credentialHash;
  }

  /** Let a standalone composition verify the exact budget used before opening a listener. */
  usesBudget(budget: ClinikoRequestBudget): boolean {
    return this.rateBudget === budget;
  }

  credentialFingerprint(): string { return this.credentialHash; }

  private reportProviderUnavailable(): void {
    try { void Promise.resolve(this.onProviderUnavailable?.()).catch(() => undefined); }
    catch { /* Diagnostics cannot change caller wording or the provider decision. */ }
  }

  private async get(path: string, signal: AbortSignal): Promise<Result<unknown, ClinikoAvailabilityFailure>> {
    if (signal.aborted) return err({ kind: "unavailable" });
    const limited = await claimClinikoBudget(this.rateBudget);
    if (limited) return err(limited);
    if (signal.aborted) return err({ kind: "unavailable" });
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: this.authorization, "User-Agent": this.userAgent },
        redirect: "error",
        signal,
      });
    } catch {
      this.reportProviderUnavailable();
      return err({ kind: "unavailable" });
    }
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 404) return err({ kind: "notFound" });
    if (response.status === 429) return err(await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset")));
    if (response.status === 422) return err({ kind: "invalidRange" });
    if (response.status >= 500) {
      this.reportProviderUnavailable();
      return err({ kind: "unavailable" });
    }
    if (response.status !== 200) return err({ kind: "malformed" });
    const parsed = await boundedJson(response);
    return signal.aborted ? err({ kind: "unavailable" }) : parsed;
  }

  private async onlineFlag(id: string, path: string, signal: AbortSignal, requireActive = false, nameField?: string, bookingDuration?: number, allowOffline = false):
    Promise<Result<Readonly<{ eligible: boolean; name?: string }>, ClinikoAvailabilityFailure>> {
    const fetched = await this.get(path, signal);
    if (!fetched.ok) return fetched;
    const body = record(fetched.value);
    if (!body || String(body.id) !== id || typeof body.show_in_online_bookings !== "boolean" ||
        // Cliniko practitioners use active status and can omit archived_at.
        // Appointment types still require their explicit unarchived evidence.
        (bookingDuration !== undefined && ((body.archived_at !== null && !(requireActive && body.archived_at === undefined)) ||
          (!requireActive && body.duration_in_minutes !== bookingDuration))) ||
        (requireActive && body.active !== true && body.active !== false && body.active !== null)) return err({ kind: "malformed" });
    if (nameField && !spokenName(body[nameField])) return err({ kind: "malformed" });
    const eligible = (body.archived_at === undefined || body.archived_at === null) &&
      (allowOffline || body.show_in_online_bookings) && (!requireActive || body.active === true);
    return ok({ eligible, ...(nameField ? { name: body[nameField] as string } : {}) });
  }

  /** Relationship lists, rather than an unscoped ID, prove this configured combination belongs together. */
  private async includesRelated(path: string, collection: "practitioners" | "appointment_types", id: string,
                                signal: AbortSignal):
    Promise<Result<boolean, ClinikoAvailabilityFailure>> {
    const seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
      const fetched = await this.get(`${path}?${query}`, signal);
      if (!fetched.ok) return fetched;
      const body = record(fetched.value);
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
          !Array.isArray(body[collection]) ||
          body[collection].length > perPage) return err({ kind: "malformed" });
      if (Number(body.total_entries) > maxPages * perPage) return err({ kind: "tooManyResults" });
      if (total !== undefined && total !== body.total_entries) return err({ kind: "unavailable" });
      total = Number(body.total_entries);
      const expected = Math.min(perPage, Math.max(0, total - (page - 1) * perPage));
      if (body[collection].length !== expected) return err({ kind: "unavailable" });
      for (const value of body[collection]) {
        const item = record(value);
        if (!item || typeof item.id !== "string" || !validId(item.id) || seen.has(item.id)) return err({ kind: "malformed" });
        seen.add(item.id);
      }
      if (seen.size === total) return ok(seen.has(id));
      if (body[collection].length === 0 || seen.size > total) return err({ kind: "unavailable" });
    }
    return err({ kind: "tooManyResults" });
  }

  private async business(signal: AbortSignal, bookingDuration?: number, allowOffline = false): Promise<Result<Readonly<{ eligible: false; reason: "business" | "appointmentType" }> |
    Readonly<{ eligible: true; timeZone: string }>, ClinikoAvailabilityFailure>> {
    const fetched = await this.get(`/businesses/${this.businessId}`, signal);
    if (!fetched.ok) return fetched;
    const body = record(fetched.value);
    if (!body || String(body.id) !== this.businessId || typeof body.show_in_online_bookings !== "boolean" ||
        (bookingDuration !== undefined && body.archived_at !== null) ||
        !(body.appointment_type_ids === null || Array.isArray(body.appointment_type_ids)) ||
        (Array.isArray(body.appointment_type_ids) && !body.appointment_type_ids.every(validId))) return err({ kind: "malformed" });
    if ((body.archived_at !== undefined && body.archived_at !== null) || !allowOffline && !body.show_in_online_bookings) {
      return ok({ eligible: false, reason: "business" });
    }
    if (body.appointment_type_ids === null || !body.appointment_type_ids.includes(this.appointmentTypeId)) {
      return ok({ eligible: false, reason: "appointmentType" });
    }
    if (typeof body.time_zone_identifier !== "string" || !body.time_zone_identifier.trim()) return err({ kind: "malformed" });
    try { new Intl.DateTimeFormat("en-AU", { timeZone: body.time_zone_identifier }); }
    catch { return err({ kind: "malformed" }); }
    return ok({ eligible: true, timeZone: body.time_zone_identifier });
  }

  async list(scope: LocationScope, from: string, to: string, parentSignal?: AbortSignal):
    Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> {
    const localSignal = AbortSignal.timeout(availabilityReadDeadlineMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, localSignal]) : localSignal;
    return settleBeforeAbort(this.listInternal(scope, from, to, false, signal), signal,
      err({ kind: "unavailable" }));
  }

  /** Used only for an explicitly approved fallback choice; names are verified from this read. */
  async listLabeled(scope: LocationScope, from: string, to: string, parentSignal?: AbortSignal):
    Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> {
    const localSignal = AbortSignal.timeout(availabilityReadDeadlineMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, localSignal]) : localSignal;
    return settleBeforeAbort(this.listInternal(scope, from, to, true, signal), signal,
      err({ kind: "unavailable" }));
  }

  /** Fresh booking eligibility/duration evidence; still observes availability without reserving it. */
  async listBooking(scope: LocationScope, from: string, to: string, durationMinutes: number, parentSignal?: AbortSignal):
    Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> {
    if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) return err({ kind: "invalidConfig" });
    const local = AbortSignal.timeout(availabilityReadDeadlineMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, local]) : local;
    return settleBeforeAbort(this.listInternal(scope, from, to, true, signal, durationMinutes), signal, err({ kind: "unavailable" }));
  }

  /** A clinic-approved longer search is split into disjoint native seven-day
   * requests. Every chunk must succeed and agree on its offering metadata. */
  async listBookingRange(scope: LocationScope, from: string, to: string, durationMinutes: number,
    maxSearchDays: number, parentSignal?: AbortSignal): Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> {
    if (!sameScope(this.scope, scope)) return err({ kind: "scopeMismatch" });
    const first = Date.parse(`${from}T00:00:00.000Z`), last = Date.parse(`${to}T00:00:00.000Z`);
    if (!validDate(from) || !validDate(to) || !Number.isSafeInteger(maxSearchDays) || maxSearchDays < 1 || maxSearchDays > 90 ||
        last < first || (last - first) / 86_400_000 + 1 > maxSearchDays) return err({ kind: "invalidRange" });
    const local = AbortSignal.timeout(availabilityReadDeadlineMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, local]) : local;
    return settleBeforeAbort((async (): Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> => {
      let captured: Extract<ClinikoAvailability, { kind: "times" }> | undefined;
      const startsAt: string[] = [];
      const days: number[] = [];
      for (let day = first; day <= last; day += 7 * 86_400_000) days.push(day);
      for (let index = 0; index < days.length; index += 3) {
        if (signal.aborted) return err({ kind: "unavailable" });
        const reads = await Promise.all(days.slice(index, index + 3).map(day => {
          const end = Math.min(last, day + 6 * 86_400_000);
          return this.listBooking(scope, new Date(day).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10), durationMinutes, signal);
        }));
        for (const read of reads) {
          if (!read.ok || read.value.kind !== "times") return read;
          const value = read.value;
          if (captured && (value.timeZone !== captured.timeZone || JSON.stringify(value.offering) !== JSON.stringify(captured.offering) ||
              value.businessRef !== captured.businessRef || value.practitionerRef !== captured.practitionerRef || value.appointmentTypeRef !== captured.appointmentTypeRef)) return err({ kind: "unavailable" });
          captured ??= value;
          startsAt.push(...value.startsAt);
        }
      }
      return !signal.aborted && captured ? ok({ ...captured, startsAt, observedAt: this.observedClock() }) : err({ kind: "unavailable" });
    })(), signal, err({ kind: "unavailable" }));
  }

  /** Metadata validation for the separately approved offline calculator. No
   * times, patient authority or reservation are produced by this read. */
  async describeRosterBooking(scope: LocationScope, durationMinutes: number, signal: AbortSignal) {
    return this.describeBookingOffering(scope, durationMinutes, signal, true);
  }
  /** Current native labels and relationships without observing or reserving a slot. */
  async describeBookingOffering(scope: LocationScope, durationMinutes: number, signal: AbortSignal, allowOffline = false) {
    if (!sameScope(this.scope, scope)) return err({ kind: "scopeMismatch" as const });
    if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480 || signal.aborted) return err({ kind: "invalidConfig" as const });
    return this.offering(signal, true, durationMinutes, allowOffline);
  }
  private async offering(signal: AbortSignal, withLabel: boolean, bookingDuration?: number, allowOffline = false):
    Promise<Result<Readonly<{ kind: "notEligible"; reason: "business" | "practitioner" | "appointmentType" }> |
      Readonly<{ kind: "offering"; timeZone: string; offering?: Readonly<{ practitionerName: string; appointmentTypeName: string }> }>, ClinikoAvailabilityFailure>> {
    const business = await this.business(signal, bookingDuration, allowOffline);
    if (!business.ok) return business;
    if (!business.value.eligible) return ok({ kind: "notEligible", reason: business.value.reason });
    const timeZone = business.value.timeZone;

    const [practitioner, appointmentType] = await Promise.all([
      this.onlineFlag(this.practitionerId, `/practitioners/${this.practitionerId}`, signal, true,
        withLabel ? "display_name" : undefined, bookingDuration, allowOffline),
      this.onlineFlag(this.appointmentTypeId, `/appointment_types/${this.appointmentTypeId}`,
        signal, false, withLabel ? "name" : undefined, bookingDuration, allowOffline),
    ]);
    if (!practitioner.ok) return practitioner;
    if (!practitioner.value.eligible) return ok({ kind: "notEligible", reason: "practitioner" });
    if (!appointmentType.ok) return appointmentType;
    if (!appointmentType.value.eligible) return ok({ kind: "notEligible", reason: "appointmentType" });
    const [businessPractitioner, practitionerType] = await Promise.all([
      this.includesRelated(`/businesses/${this.businessId}/practitioners`, "practitioners", this.practitionerId, signal),
      this.includesRelated(`/practitioners/${this.practitionerId}/appointment_types`, "appointment_types", this.appointmentTypeId, signal),
    ]);
    if (!businessPractitioner.ok) return businessPractitioner;
    if (!businessPractitioner.value) return ok({ kind: "notEligible", reason: "practitioner" });
    if (!practitionerType.ok) return practitionerType;
    if (!practitionerType.value) return ok({ kind: "notEligible", reason: "appointmentType" });

    return ok({ kind: "offering", timeZone, ...(withLabel ? { offering: { practitionerName: practitioner.value.name!, appointmentTypeName: appointmentType.value.name! } } : {}) });
  }

  private async listInternal(scope: LocationScope, from: string, to: string, withLabel: boolean,
                             signal: AbortSignal, bookingDuration?: number):
    Promise<Result<ClinikoAvailability, ClinikoAvailabilityFailure>> {
    if (!sameScope(this.scope, scope)) return err({ kind: "scopeMismatch" });
    if (!validDate(from) || !validDate(to) || Date.parse(`${to}T00:00:00Z`) < Date.parse(`${from}T00:00:00Z`) ||
        Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 7 * 86_400_000) return err({ kind: "invalidRange" });

    const metadata = await this.offering(signal, withLabel, bookingDuration);
    if (!metadata.ok) return metadata;
    if (metadata.value.kind === "notEligible") return ok(metadata.value);
    const timeZone = metadata.value.timeZone;
    const clinicDate = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn",
      year: "numeric", month: "2-digit", day: "2-digit" });
    const prefix = `/businesses/${this.businessId}/practitioners/${this.practitionerId}/appointment_types/${this.appointmentTypeId}/available_times`;
    const startsAt: string[] = [];
    let totalEntries: number | undefined;
    let lastStart = -Infinity;
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ from, to, page: String(page), per_page: String(perPage) });
      const fetched = await this.get(`${prefix}?${query}`, signal);
      if (!fetched.ok) return fetched;
      const body = record(fetched.value);
      if (!body || !Number.isInteger(body.total_entries) || Number(body.total_entries) < 0 || !Array.isArray(body.available_times)) return err({ kind: "malformed" });
      const count = Number(body.total_entries);
      if (count > maxPages * perPage) return err({ kind: "tooManyResults" });
      if (totalEntries !== undefined && count !== totalEntries) return err({ kind: "unavailable" });
      totalEntries = count;
      const expected = Math.min(perPage, Math.max(0, count - (page - 1) * perPage));
      if (body.available_times.length !== expected) return err({ kind: "unavailable" });
      for (const candidate of body.available_times) {
        const row = record(candidate);
        if (!row || typeof row.appointment_start !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.appointment_start) ||
            !Number.isFinite(Date.parse(row.appointment_start))) return err({ kind: "malformed" });
        const start = new Date(row.appointment_start);
        if (start.getTime() <= lastStart) return err({ kind: "unavailable" });
        lastStart = start.getTime();
        const parts = clinicDate.formatToParts(start);
        const field = (name: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === name)?.value;
        const localDate = `${field("year")}-${field("month")}-${field("day")}`;
        if (localDate < from || localDate > to) return err({ kind: "malformed" });
        startsAt.push(start.toISOString());
      }
      if (startsAt.length >= count) break;
      if (body.available_times.length === 0) return err({ kind: "unavailable" });
    }
    if (signal.aborted || startsAt.length !== totalEntries || new Set(startsAt).size !== startsAt.length) {
      return err({ kind: "unavailable" });
    }
    let observedAt: string;
    try { observedAt = this.observedClock(); }
    catch { return err({ kind: "unavailable" }); }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) return err({ kind: "unavailable" });
    return ok({ kind: "times", scope: structuredClone(this.scope), sourceRef: `cliniko:${this.businessId}:${this.practitionerId}:${this.appointmentTypeId}`,
      timeZone, observedAt, businessRef: this.businessId, practitionerRef: this.practitionerId,
      appointmentTypeRef: this.appointmentTypeId, startsAt, reservable: false,
      ...(metadata.value.offering ? { offering: metadata.value.offering } : {}) });
  }
}
