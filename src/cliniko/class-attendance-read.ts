import { isDeepStrictEqual } from "node:util";
import type { PatientProofHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, VerifiedPatient } from "../core/model.ts";
import { boundedClinikoJson } from "./bounded-json.ts";
import { claimClinikoBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";

export type ClinikoClassReadFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidQuery" | "invalidProof" | "forbidden" |
    "rateLimited" | "unavailable" | "malformed" | "tooManyResults" | "changed";
  resetAt?: string;
}>;
export type ClinikoClassSession = Readonly<{
  sessionRef: string; startsAt: string; endsAt: string; capacity: number; activeAttendanceCount: number;
  remainingPlaces: number; overCapacity: boolean;
  attendance: Readonly<{ kind: "none" | "ambiguous" }> | Readonly<{ kind: "one"; attendeeRef: string }>;
}>;
export type ClinikoClassRead = Readonly<{
  scope: LocationScope; sourceRef: string; observedAt: string; timeZone: string; className: string;
  patientRef: string; verificationRef: string; proofExpiresAt: string; reservable: false;
  sessions: readonly ClinikoClassSession[];
}>;
export type ClinikoClassReadConfig = Readonly<{
  scope: LocationScope; apiKey: string; contactEmail: string; businessId: string;
  practitionerId: string; appointmentTypeId: string; className: string; rateBudget: ClinikoRequestBudget;
}>;
type Row = Record<string, unknown>;
type NativeSession = Readonly<{ id: string; startsAt: string; endsAt: string; capacity: number; active: boolean }>;
type NativeAttendee = Readonly<{ id: string; patientId: string; active: boolean }>;
type Snapshot = Readonly<{ timeZone: string; typeCapacity: number; sessions: readonly Readonly<{ session: NativeSession; attendees: readonly NativeAttendee[] }>[] }>;
const object = (v: unknown): Row | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const scopeValid = (v: unknown): v is LocationScope => {
  const row = object(v); return !!row && [row.tenantId, row.clinicId, row.locationId].every(part => typeof part === "string" && part.trim().length > 0 && part.length <= 256);
};
const sameScope = (a: LocationScope, b: LocationScope) => a.tenantId === b.tenantId && a.clinicId === b.clinicId && a.locationId === b.locationId;
const instant = (v: unknown): number | undefined => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return undefined;
  const [year, month, day] = v.slice(0, 10).split("-").map(Number);
  if (new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) !== v.slice(0, 10)) return undefined;
  return Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined;
};
class ReadFailure extends Error {
  readonly failure: ClinikoClassReadFailure;
  constructor(failure: ClinikoClassReadFailure) { super(failure.kind); this.failure = failure; }
}
const fail = (kind: ClinikoClassReadFailure["kind"]): never => { throw new ReadFailure({ kind }); };

/** Existing native class occurrences only. Attendance is read privately to
 * count occupied places and identify this verified patient's own record.
 * Neither other patients nor class-shared notes escape this module. These
 * observations grant no reservation, membership credit or write permission. */
export class ClinikoClassAttendanceReader {
  readonly #config: ClinikoClassReadConfig;
  readonly #base: string;
  readonly #proof: PatientProofHost;
  readonly #fetch: typeof fetch;
  readonly #clock: () => string;
  private constructor(config: ClinikoClassReadConfig, shard: string, proof: PatientProofHost, fetchPort: typeof fetch, clock: () => string) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#base = `https://api.${shard}.cliniko.com/v1`; this.#proof = proof; this.#fetch = fetchPort; this.#clock = clock;
  }
  static create(config: ClinikoClassReadConfig, proof: PatientProofHost, fetchPort: typeof fetch = fetch,
    clock: () => string = () => new Date().toISOString()): Result<ClinikoClassAttendanceReader, ClinikoClassReadFailure> {
    const shard = typeof config?.apiKey === "string" ? /-([a-z]{2}[0-9]{1,2})$/.exec(config.apiKey)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
      !scopeValid(config.scope) || ![config.businessId, config.practitionerId, config.appointmentTypeId].every(id) ||
      typeof config.contactEmail !== "string" || config.contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) ||
      typeof config.className !== "string" || config.className.trim() !== config.className || !config.className || config.className.length > 255 ||
      /[\u0000-\u001f\u007f]/.test(config.className) || !isClinikoRequestBudget(config.rateBudget) ||
      typeof proof?.verifyPatient !== "function" || typeof fetchPort !== "function" || typeof clock !== "function") return err({ kind: "invalidConfig" });
    return ok(new ClinikoClassAttendanceReader(config, shard, proof, fetchPort, clock));
  }
  async #get(path: string, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return fail("unavailable");
    const limited = await claimClinikoBudget(this.#config.rateBudget); if (limited) throw new ReadFailure(limited);
    if (signal.aborted) return fail("unavailable");
    const response = await this.#fetch(`${this.#base}${path}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` } });
    if (response.status === 401 || response.status === 403) return fail("forbidden");
    if (response.status === 429) throw new ReadFailure(await observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset")));
    if (response.status >= 500) return fail("unavailable");
    if (response.status !== 200) return fail("malformed");
    const body = await boundedClinikoJson(response); if (!body.ok) throw new ReadFailure(body.error);
    if (signal.aborted) return fail("unavailable"); return body.value;
  }
  #link(value: unknown, resource: string): string | undefined {
    const self = object(object(value)?.links)?.self;
    if (typeof self !== "string" || !self.startsWith(`${this.#base}/${resource}/`)) return undefined;
    const found = self.slice(`${this.#base}/${resource}/`.length); return id(found) ? found : undefined;
  }
  #active(row: Row, attendee: boolean): boolean {
    const flags = [row.archived_at, row.deleted_at, ...(attendee ? [row.cancelled_at] : [])];
    if (flags.some(flag => flag !== null && instant(flag) === undefined)) return fail("malformed");
    return flags.every(flag => flag === null);
  }
  async #collection(resource: string, filters: readonly string[], signal: AbortSignal): Promise<Row[]> {
    const name = resource.split("/").at(-1)!;
    const rows: Row[] = [], seen = new Set<string>(); let total: number | undefined;
    for (let page = 1; page <= 5; page++) {
      const query = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
      for (const filter of filters) query.append("q[]", filter);
      const body = object(await this.#get(`/${resource}?${query}`, signal)), entries = body?.[name];
      if (!body || !Array.isArray(entries) || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
        total !== undefined && total !== body.total_entries) return fail("malformed");
      total = Number(body.total_entries); if (total > 500) return fail("tooManyResults");
      if (entries.length !== Math.min(100, total - rows.length)) return fail("malformed");
      for (const entry of entries) {
        const row = object(entry);
        if (!row || !id(row.id) || seen.has(row.id) || this.#link(row, name) !== row.id) return fail("malformed");
        seen.add(row.id); rows.push(row);
      }
      if (rows.length === total) {
        if (object(body.links)?.next != null) return fail("malformed");
        return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      }
    }
    return fail("tooManyResults");
  }
  async #metadata(signal: AbortSignal): Promise<{ timeZone: string; typeCapacity: number }> {
    const c = this.#config;
    const business = object(await this.#get(`/businesses/${c.businessId}`, signal));
    if (!business || business.id !== c.businessId || business.archived_at !== null ||
      !Array.isArray(business.appointment_type_ids) || !business.appointment_type_ids.every(id) || !business.appointment_type_ids.includes(c.appointmentTypeId) ||
      typeof business.time_zone_identifier !== "string") return fail("malformed");
    try { new Intl.DateTimeFormat("en-AU", { timeZone: business.time_zone_identifier }); } catch { return fail("malformed"); }
    const practitioner = object(await this.#get(`/practitioners/${c.practitionerId}`, signal));
    if (!practitioner || practitioner.id !== c.practitionerId || practitioner.active !== true) return fail("malformed");
    const type = object(await this.#get(`/appointment_types/${c.appointmentTypeId}`, signal));
    if (!type || type.id !== c.appointmentTypeId || type.archived_at !== null || !Number.isSafeInteger(type.max_attendees) ||
      Number(type.max_attendees) <= 1 || Number(type.max_attendees) > 100) return fail("malformed");
    // Native relationships, not caller-selected IDs, establish this pair.
    const businesses = await this.#collection(`practitioners/${c.practitionerId}/businesses`, [], signal);
    const types = await this.#collection(`practitioners/${c.practitionerId}/appointment_types`, [], signal);
    if (!businesses.some(row => row.id === c.businessId) || !types.some(row => row.id === c.appointmentTypeId)) return fail("malformed");
    return { timeZone: business.time_zone_identifier, typeCapacity: Number(type.max_attendees) };
  }
  async #snapshot(from: string, to: string, signal: AbortSignal, selected?: readonly string[]): Promise<Snapshot> {
    const c = this.#config, metadata = await this.#metadata(signal);
    const groups = selected ? await Promise.all(selected.map(async ref => {
      const row = object(await this.#get(`/group_appointments/${ref}`, signal));
      if (!row || row.id !== ref) return fail("malformed");
      return row;
    })) :
      await this.#collection("group_appointments", [`business_id:=${c.businessId}`, `practitioner_id:=${c.practitionerId}`,
        `appointment_type_id:=${c.appointmentTypeId}`, `starts_at:>=${from}`, `starts_at:<${to}`], signal);
    if (groups.length > 30) return fail("tooManyResults");
    const sessions: { session: NativeSession; attendees: NativeAttendee[] }[] = [];
    for (const group of groups) {
      const start = instant(group.starts_at), end = instant(group.ends_at);
      if (!id(group.id) || selected && !selected.includes(String(group.id)) || this.#link(group, "group_appointments") !== group.id ||
        this.#link(group.business, "businesses") !== c.businessId || this.#link(group.practitioner, "practitioners") !== c.practitionerId ||
        this.#link(group.appointment_type, "appointment_types") !== c.appointmentTypeId || start === undefined || end === undefined ||
        start < Date.parse(from) || start >= Date.parse(to) || end <= start || end - start > 86_400_000 ||
        !Number.isSafeInteger(group.max_attendees) || Number(group.max_attendees) < 1 || Number(group.max_attendees) > 100) return fail("malformed");
      const active = this.#active(group, false);
      if (!active) continue;
      const attendees = await this.#collection("attendees", [`booking_id:=${group.id}`], signal);
      sessions.push({ session: { id: group.id, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), capacity: Number(group.max_attendees), active },
        attendees: attendees.map(row => {
          const patientId = this.#link(row.patient, "patients");
          if (!patientId || this.#link(row.booking, "bookings") !== group.id) return fail("malformed");
          return { id: String(row.id), patientId, active: this.#active(row, true) };
        }) });
    }
    return { ...metadata, sessions: sessions.sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt) || a.session.id.localeCompare(b.session.id)) };
  }
  async #verified(scope: LocationScope, ref: string, signal: AbortSignal): Promise<VerifiedPatient> {
    if (signal.aborted) return fail("unavailable");
    const observedAt = this.#clock(), now = instant(observedAt);
    if (now === undefined) return fail("unavailable");
    const result = await this.#proof.verifyPatient(scope, ref, observedAt, signal);
    if (!result.ok) return fail(result.error.kind === "unavailable" ? "unavailable" : "invalidProof");
    const p = result.value;
    if (!scopeValid(p.scope) || !sameScope(scope, p.scope) || p.verificationRef !== ref || !id(p.patientRef) ||
      instant(p.expiresAt) === undefined || instant(p.expiresAt)! <= now + 120_000 || signal.aborted) return fail("invalidProof");
    return p;
  }
  async list(scope: LocationScope, verificationRef: string, from: string, to: string, now: string, signal: AbortSignal): Promise<Result<ClinikoClassRead, ClinikoClassReadFailure>> {
    return this.#read(scope, verificationRef, from, to, now, signal);
  }
  /** Re-read one existing occurrence; a remembered menu choice is never fresh capacity evidence. */
  async inspect(scope: LocationScope, verificationRef: string, sessionRef: string, from: string, to: string, now: string, signal: AbortSignal): Promise<Result<ClinikoClassRead, ClinikoClassReadFailure>> {
    if (!id(sessionRef)) return err({ kind: "invalidQuery" });
    return this.#read(scope, verificationRef, from, to, now, signal, [sessionRef]);
  }
  /** One coherent double snapshot for the two exact existing occurrences in a
   * move. Metadata and proof are shared within this read, never across calls. */
  async inspectPair(scope: LocationScope, verificationRef: string, sessionRefs: readonly [string, string], from: string, to: string, now: string, signal: AbortSignal): Promise<Result<ClinikoClassRead, ClinikoClassReadFailure>> {
    if (!Array.isArray(sessionRefs) || sessionRefs.length !== 2 || !sessionRefs.every(id) || sessionRefs[0] === sessionRefs[1]) return err({ kind: "invalidQuery" });
    return this.#read(scope, verificationRef, from, to, now, signal, [...sessionRefs]);
  }
  async #read(scope: LocationScope, ref: string, from: string, to: string, now: string, parentSignal: AbortSignal, selected?: readonly string[]): Promise<Result<ClinikoClassRead, ClinikoClassReadFailure>> {
    if (!scopeValid(scope) || !sameScope(scope, this.#config.scope)) return err({ kind: "scopeMismatch" });
    const start = instant(from), end = instant(to), supplied = instant(now);
    let observed: number | undefined; try { observed = instant(this.#clock()); } catch { return err({ kind: "unavailable" }); }
    if (typeof ref !== "string" || !ref.trim() || ref.length > 256 || start === undefined || end === undefined || supplied === undefined || observed === undefined ||
      Math.abs(supplied - observed) > 30_000 || start < observed - 30_000 || end <= start || end - observed > 90 * 86_400_000 ||
      !(parentSignal instanceof AbortSignal)) return err({ kind: "invalidQuery" });
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15_000)]);
    const work = (async (): Promise<Result<ClinikoClassRead, ClinikoClassReadFailure>> => {
      try {
        const patient = await this.#verified(scope, ref, signal), before = await this.#snapshot(from, to, signal, selected);
        const after = await this.#snapshot(from, to, signal, selected), metadata = await this.#metadata(signal);
        const current = await this.#verified(scope, ref, signal);
        if (patient.patientRef !== current.patientRef || !isDeepStrictEqual(before, after) ||
          !isDeepStrictEqual(metadata, { timeZone: after.timeZone, typeCapacity: after.typeCapacity })) return err({ kind: "changed" });
        return ok({ scope: { ...scope }, sourceRef: `cliniko:classes:${this.#config.businessId}:${this.#config.practitionerId}:${this.#config.appointmentTypeId}`,
          observedAt: this.#clock(), timeZone: after.timeZone, className: this.#config.className, patientRef: current.patientRef,
          verificationRef: ref, proofExpiresAt: current.expiresAt, reservable: false, sessions: after.sessions.map(({ session, attendees }) => {
            const active = attendees.filter(row => row.active), own = active.filter(row => row.patientId === current.patientRef);
            return { sessionRef: session.id, startsAt: session.startsAt, endsAt: session.endsAt, capacity: session.capacity,
              activeAttendanceCount: active.length, remainingPlaces: Math.max(0, session.capacity - active.length), overCapacity: active.length > session.capacity,
              attendance: own.length === 1 ? { kind: "one", attendeeRef: own[0]!.id } : { kind: own.length > 1 ? "ambiguous" : "none" } };
          }) });
      } catch (error) { return err(error instanceof ReadFailure ? error.failure : { kind: "unavailable" }); }
    })();
    let stop = () => {};
    const aborted = new Promise<Result<ClinikoClassRead, ClinikoClassReadFailure>>(resolve => {
      stop = () => resolve(err({ kind: "unavailable" })); signal.addEventListener("abort", stop); if (signal.aborted) stop();
    });
    try { return await Promise.race([work, aborted]); } finally { signal.removeEventListener("abort", stop); }
  }
}
