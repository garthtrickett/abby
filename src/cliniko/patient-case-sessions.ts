import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { PatientProofHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result, VerifiedPatient } from "../core/model.ts";
import { clinicDateAt } from "../standalone/clinic-clock.ts";
import { boundedClinikoJson } from "./bounded-json.ts";
import { claimClinikoBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

export type ClinikoCaseFailure = Readonly<{
  kind: "invalidConfig" | "invalidQuery" | "scopeMismatch" | "invalidProof" | "forbidden" |
    "unavailable" | "rateLimited" | "malformed" | "tooManyResults" | "changed";
  resetAt?: string;
}>;
/** Exact native references are supplied by independent host authority, never by
 * the model or a case-name search. A session counter is not proof of payment. */
export type ClinikoCaseQuery = Readonly<{
  scope: LocationScope; verificationRef: string; patientCaseId: string;
  classSessionId: string; startsAt: string; now: string;
}>;
export type ClinikoCasePermission = Readonly<{
  allows(query: ClinikoCaseQuery & Readonly<{ patientId: string; signal: AbortSignal }>): Promise<boolean>;
}>;
export type ClinikoCaseSessions = Readonly<{
  patientCaseId: string; patientId: string; verificationRef: string; observedAt: string;
  maximum: number; used: number; remaining: number; overdrawn: boolean;
  eligibleOnSessionDate: boolean; includeCancelled: boolean; includeDna: boolean;
  usageFingerprint: string;
  /** No money, invoice, membership or reservation authority is inferred. */
  financialAuthority: "none"; reservable: false;
}>;
export type ClinikoCaseAttendance = ClinikoCaseSessions & Readonly<{ attendance: Readonly<{ attendeeId: string; countsSession: boolean }> }>;
type CaseObservation = ClinikoCaseSessions & Readonly<{ attendance?: ClinikoCaseAttendance["attendance"] }>;
type AttendanceCheck = Readonly<{ kind: "addition" | "cancellation"; usageFingerprint: string; attendeeId: string }> |
  Readonly<{ kind: "attendance"; attendeeId: string }>;
export type ClinikoCaseConfig = Readonly<{
  scope: LocationScope; apiKey: string; contactEmail: string; timeZone: string; rateBudget: ClinikoRequestBudget;
  /** Deploying owner must accept this native attendee status interpretation. */
  attendanceStatus: "arrivedFalseIsDna";
}>;
type Row = Record<string, unknown>;
const object = (v: unknown): Row | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const scopeValid = (v: unknown): v is LocationScope => {
  const row = object(v); return !!row && [row.tenantId, row.clinicId, row.locationId].every(p => typeof p === "string" && !!p.trim() && p.length <= 256);
};
const sameScope = (a: LocationScope, b: LocationScope) => a.tenantId === b.tenantId && a.clinicId === b.clinicId && a.locationId === b.locationId;
const day = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && day(v.slice(0, 10)) && Number.isFinite(Date.parse(v));
class CaseFailure extends Error {
  readonly detail: ClinikoCaseFailure;
  constructor(detail: ClinikoCaseFailure) { super(detail.kind); this.detail = detail; }
}
const fail = (kind: ClinikoCaseFailure["kind"]): never => { throw new CaseFailure({ kind }); };
type Snapshot = Readonly<{
  maximum: number; includeCancelled: boolean; includeDna: boolean; issue: string | null; expiry: string | null;
  closedAt: string | null; archivedAt: string | null;
  attendees: readonly Readonly<{ id: string; bookingId: string; arrived: boolean | null; cancelled: string | null; archived: string | null; deleted: string | null }>[];
}>;

/** Private, complete native case counter. Counts all associated appointments,
 * including individual appointments and other services, not only this class.
 * Case names, notes, referrals and unrelated patient data never leave the edge.
 * This read cannot select a pass, link attendance, spend money or grant consent. */
export class ClinikoPatientCaseSessionsReader {
  readonly #config: ClinikoCaseConfig;
  readonly #base: string;
  readonly #proof: PatientProofHost;
  readonly #permission: ClinikoCasePermission;
  readonly #fetch: typeof fetch;
  readonly #clock: () => string;
  private constructor(config: ClinikoCaseConfig, shard: string, proof: PatientProofHost, permission: ClinikoCasePermission, fetchPort: typeof fetch, clock: () => string) {
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) });
    this.#base = `https://api.${shard}.cliniko.com/v1`; this.#proof = proof; this.#permission = permission; this.#fetch = fetchPort; this.#clock = clock;
  }
  static create(config: ClinikoCaseConfig, proof: PatientProofHost, permission: ClinikoCasePermission, fetchPort: typeof fetch = fetch,
    clock: () => string = () => new Date().toISOString()): Result<ClinikoPatientCaseSessionsReader, ClinikoCaseFailure> {
    const shard = typeof config?.apiKey === "string" ? /-([a-z]{2}[0-9]{1,2})$/.exec(config.apiKey)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) || !scopeValid(config.scope) ||
      typeof config.contactEmail !== "string" || config.contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) ||
      config.attendanceStatus !== "arrivedFalseIsDna" || !isClinikoRequestBudget(config.rateBudget) || typeof config.timeZone !== "string" ||
      typeof proof?.verifyPatient !== "function" || typeof permission?.allows !== "function" || typeof fetchPort !== "function" || typeof clock !== "function") return err({ kind: "invalidConfig" });
    try { new Intl.DateTimeFormat("en", { timeZone: config.timeZone }); } catch { return err({ kind: "invalidConfig" }); }
    return ok(new ClinikoPatientCaseSessionsReader(config, shard, proof, permission, fetchPort, clock));
  }
  #link(value: unknown, resource: string): string | undefined {
    const self = object(object(value)?.links)?.self;
    if (typeof self !== "string" || !self.startsWith(`${this.#base}/${resource}/`)) return undefined;
    const found = self.slice(`${this.#base}/${resource}/`.length); return id(found) ? found : undefined;
  }
  async #get(path: string, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return fail("unavailable");
    const limited = await claimClinikoBudget(this.#config.rateBudget); if (limited) throw new CaseFailure(limited);
    if (signal.aborted) return fail("unavailable");
    const response = await this.#fetch(`${this.#base}${path}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` } });
    if (response.status === 401 || response.status === 403) return fail("forbidden");
    if (response.status === 429) throw new CaseFailure(await observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset")));
    if (response.status !== 200) return fail("unavailable");
    const body = await boundedClinikoJson(response); if (!body.ok) throw new CaseFailure(body.error);
    return body.value;
  }
  async #authority(query: ClinikoCaseQuery, signal: AbortSignal): Promise<VerifiedPatient> {
    const now = this.#clock(); if (!instant(now) || signal.aborted) return fail("unavailable");
    const found = await this.#proof.verifyPatient(query.scope, query.verificationRef, now, signal);
    if (!found.ok) return fail(found.error.kind === "unavailable" ? "unavailable" : "invalidProof");
    const p = found.value;
    if (!scopeValid(p.scope) || !sameScope(query.scope, p.scope) || !id(p.patientRef) || p.verificationRef !== query.verificationRef ||
      !instant(p.expiresAt) || Date.parse(p.expiresAt) <= Date.parse(now) + 120000) return fail("invalidProof");
    if (signal.aborted || await this.#permission.allows({ ...structuredClone(query), patientId: p.patientRef, signal }) !== true || signal.aborted) return fail("forbidden");
    return p;
  }
  async #snapshot(query: ClinikoCaseQuery, patientId: string, signal: AbortSignal): Promise<Snapshot> {
    const row = object(await this.#get(`/patient_cases/${query.patientCaseId}`, signal));
    if (!row || row.id !== query.patientCaseId || this.#link(row, "patient_cases") !== query.patientCaseId || this.#link(row.patient, "patients") !== patientId ||
      !Number.isSafeInteger(row.max_sessions) || Number(row.max_sessions) < 1 || Number(row.max_sessions) > 300 ||
      typeof row.include_cancelled_attendees !== "boolean" || typeof row.include_dna_attendees !== "boolean" ||
      ![row.issue_date, row.expiry_date].every(v => v === null || day(v)) || ![row.closed_at, row.archived_at].every(v => v === null || instant(v)) ||
      row.issue_date !== null && row.expiry_date !== null && String(row.issue_date) > String(row.expiry_date) ||
      !Array.isArray(row.attendee_ids) || !row.attendee_ids.every(id) || new Set(row.attendee_ids).size !== row.attendee_ids.length) return fail("malformed");
    const expected = row.attendee_ids as string[];
    if (expected.length > 1000) return fail("tooManyResults");
    const attendees: Snapshot["attendees"][number][] = [], seen = new Set<string>(); let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const queryString = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
      // No service, business, patient or future-date filter: every case use counts.
      const body = object(await this.#get(`/patient_cases/${query.patientCaseId}/attendees?${queryString}`, signal)), entries = body?.attendees;
      if (!body || !Array.isArray(entries) || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
        total !== undefined && total !== body.total_entries) return fail("malformed");
      total = Number(body.total_entries); if (total > 1000) return fail("tooManyResults");
      if (entries.length !== Math.min(100, total - attendees.length)) return fail("malformed");
      for (const entry of entries) {
        const a = object(entry), bookingId = a && this.#link(a.booking, "bookings");
        if (!a || !id(a.id) || seen.has(a.id) || !expected.includes(a.id) || this.#link(a, "attendees") !== a.id || !bookingId ||
          this.#link(a.patient, "patients") !== patientId || this.#link(a.patient_case, "patient_cases") !== query.patientCaseId ||
          a.arrived !== null && typeof a.arrived !== "boolean" || ![a.cancelled_at, a.archived_at, a.deleted_at].every(v => v === null || instant(v))) return fail("malformed");
        seen.add(a.id);
        attendees.push({ id: a.id, bookingId, arrived: a.arrived as boolean | null, cancelled: a.cancelled_at as string | null, archived: a.archived_at as string | null, deleted: a.deleted_at as string | null });
      }
      if (attendees.length === total) {
        if (object(body.links)?.next != null || seen.size !== expected.length) return fail("malformed");
        return { maximum: Number(row.max_sessions), includeCancelled: row.include_cancelled_attendees, includeDna: row.include_dna_attendees,
          issue: row.issue_date as string | null, expiry: row.expiry_date as string | null, closedAt: row.closed_at as string | null, archivedAt: row.archived_at as string | null,
          attendees: attendees.sort((a, b) => a.id.localeCompare(b.id)) };
      }
    }
    return fail("tooManyResults");
  }
  async read(input: ClinikoCaseQuery, parentSignal: AbortSignal): Promise<Result<ClinikoCaseSessions, ClinikoCaseFailure>> {
    return this.#read(input, parentSignal);
  }
  /** Confirm one exact new active attendance against the previously observed
   * private case state. Other additions/removals/status/rule changes cannot be
   * hidden by an unchanged net counter. This is observation, not a reservation. */
  async inspectAddition(input: ClinikoCaseQuery, usageFingerprint: string, attendeeId: string, parentSignal: AbortSignal): Promise<Result<ClinikoCaseSessions, ClinikoCaseFailure>> {
    if (!/^[a-f0-9]{64}$/.test(usageFingerprint) || !id(attendeeId)) return err({ kind: "invalidQuery" });
    return this.#read(input, parentSignal, { kind: "addition", usageFingerprint, attendeeId });
  }
  /** Existing own active attendance, including its actual contribution under
   * the case's DNA rules. No remaining-session or active-pass prerequisite. */
  async inspectAttendance(input: ClinikoCaseQuery, attendeeId: string, parentSignal: AbortSignal): Promise<Result<ClinikoCaseAttendance, ClinikoCaseFailure>> {
    if (!id(attendeeId)) return err({ kind: "invalidQuery" });
    const found = await this.#read(input, parentSignal, { kind: "attendance", attendeeId });
    return found.ok ? found.value.attendance ? ok({ ...found.value, attendance: found.value.attendance }) : err({ kind: "changed" }) : found;
  }
  /** Only the selected attendee's cancelled state may change. Metadata and all
   * other uses must match the exact prior private state, even at equal counts. */
  async inspectCancellation(input: ClinikoCaseQuery, usageFingerprint: string, attendeeId: string, parentSignal: AbortSignal): Promise<Result<ClinikoCaseSessions, ClinikoCaseFailure>> {
    if (!/^[a-f0-9]{64}$/.test(usageFingerprint) || !id(attendeeId)) return err({ kind: "invalidQuery" });
    return this.#read(input, parentSignal, { kind: "cancellation", usageFingerprint, attendeeId });
  }
  async #read(input: ClinikoCaseQuery, parentSignal: AbortSignal, check?: AttendanceCheck): Promise<Result<CaseObservation, ClinikoCaseFailure>> {
    if (!scopeValid(input?.scope) || !sameScope(input.scope, this.#config.scope)) return err({ kind: "scopeMismatch" });
    let now: string; try { now = this.#clock(); } catch { return err({ kind: "unavailable" }); }
    if (!id(input.patientCaseId) || !id(input.classSessionId) || typeof input.verificationRef !== "string" || !input.verificationRef.trim() || input.verificationRef.length > 256 ||
      !instant(input.startsAt) || !instant(input.now) || !instant(now) || Math.abs(Date.parse(input.now) - Date.parse(now)) > 30000 || Date.parse(input.startsAt) < Date.parse(now) ||
      Date.parse(input.startsAt) - Date.parse(now) > 90 * 86400000 || !(parentSignal instanceof AbortSignal)) return err({ kind: "invalidQuery" });
    const query = structuredClone(input), signal = AbortSignal.any([parentSignal, AbortSignal.timeout(15000)]);
    const work = (async (): Promise<Result<CaseObservation, ClinikoCaseFailure>> => {
      try {
        const patient = await this.#authority(query, signal), before = await this.#snapshot(query, patient.patientRef, signal);
        const after = await this.#snapshot(query, patient.patientRef, signal), current = await this.#authority(query, signal);
        if (patient.patientRef !== current.patientRef || !isDeepStrictEqual(before, after)) return err({ kind: "changed" });
        const fingerprint = (snapshot: Snapshot) => createHash("sha256").update(JSON.stringify({ patientCaseId: query.patientCaseId, patientId: current.patientRef, snapshot })).digest("hex");
        const selected = check ? after.attendees.find(a => a.id === check.attendeeId) : undefined;
        if (check && (!selected || selected.bookingId !== query.classSessionId || selected.archived !== null || selected.deleted !== null)) return err({ kind: "changed" });
        if (check?.kind === "addition") {
          const added = selected!;
          if (!added || added.bookingId !== query.classSessionId || added.archived !== null || added.deleted !== null || added.cancelled !== null || added.arrived === false ||
            fingerprint({ ...after, attendees: after.attendees.filter(a => a.id !== check.attendeeId) }) !== check.usageFingerprint) return err({ kind: "changed" });
        }
        if (check?.kind === "attendance" && selected!.cancelled !== null) return err({ kind: "changed" });
        if (check?.kind === "cancellation" && (selected!.cancelled === null || fingerprint({ ...after,
          attendees: after.attendees.map(a => a.id === check.attendeeId ? { ...a, cancelled: null } : a) }) !== check.usageFingerprint)) return err({ kind: "changed" });
        const used = after.attendees.filter(a => a.archived === null && a.deleted === null &&
          (a.cancelled !== null ? after.includeCancelled : a.arrived === false ? after.includeDna : true)).length;
        const sessionDate = clinicDateAt(this.#config.timeZone, new Date(query.startsAt));
        const observedAt = this.#clock(); if (!instant(observedAt) || signal.aborted) return fail("unavailable");
        return ok({ patientCaseId: query.patientCaseId, patientId: current.patientRef, verificationRef: query.verificationRef, observedAt,
          maximum: after.maximum, used, remaining: Math.max(0, after.maximum - used), overdrawn: used > after.maximum,
          eligibleOnSessionDate: after.closedAt === null && after.archivedAt === null && (!after.issue || sessionDate >= after.issue) && (!after.expiry || sessionDate <= after.expiry),
          includeCancelled: after.includeCancelled, includeDna: after.includeDna, usageFingerprint: fingerprint(after), financialAuthority: "none", reservable: false,
          ...(check?.kind === "attendance" ? { attendance: { attendeeId: check.attendeeId, countsSession: selected!.arrived !== false || after.includeDna } } : {}) });
      } catch (error) { return err(error instanceof CaseFailure ? error.detail : { kind: "unavailable" }); }
    })();
    return await awaitUntilAbort(work, signal) ?? err({ kind: "unavailable" });
  }
}
