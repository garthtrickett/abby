import type { PatientProofHost } from "../core/host.ts";
import { err, ok } from "../core/model.ts";
import type { LocationScope, VerifiedPatient } from "../core/model.ts";
import type { PreviousPractitionerResult } from "../core/previous-practitioner.ts";
import { normalizedSpokenName } from "../core/pending-location.ts";
import { boundedClinikoJson } from "./bounded-json.ts";
import { claimClinikoBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";

type Config = Readonly<{ scope: LocationScope; apiKey: string; contactEmail: string; businessId: string; timeZone: string;
  lookBackDays: number; rateBudget: ClinikoRequestBudget }>;
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d*$/.test(value);
function instant(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!parts) return NaN;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return NaN;
  return Date.parse(value);
}
const self = (value: unknown) => record(record(value)?.links)?.self;
const denied = () => err({ kind: "unavailable" as const });

/** A read proof chooses the subject. Only fixed-origin native requests are
 * made; provider links are validated as data and never followed. */
export class ClinikoPreviousPractitionerReader {
  readonly #config: Config;
  readonly #base: string;
  readonly #proof: PatientProofHost;
  readonly #fetch: typeof fetch;
  constructor(config: Config, proof: PatientProofHost, fetchPort: typeof fetch = fetch) {
    const shard = config.apiKey.match(/-([a-z]{2}\d{1,2})$/)?.[1];
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.contactEmail) || !id(config.businessId) ||
        !Number.isSafeInteger(config.lookBackDays) || config.lookBackDays < 1 || config.lookBackDays > 36525 || !isClinikoRequestBudget(config.rateBudget)) throw new TypeError("invalid history reader");
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }) }); this.#base = `https://api.${shard}.cliniko.com/v1`; this.#proof = proof; this.#fetch = fetchPort;
  }
  async #get(path: string, signal: AbortSignal) {
    if (signal.aborted || await claimClinikoBudget(this.#config.rateBudget)) return denied();
    const response = await awaitUntilAbort(this.#fetch(`${this.#base}${path}`, { method: "GET", redirect: "error", signal,
      headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` } }), signal);
    if (!response || signal.aborted) return denied();
    if (response.status === 429) { await observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset")); return denied(); }
    return response.status === 200 ? await awaitUntilAbort(boundedClinikoJson(response), signal) ?? denied() : denied();
  }
  async read(verificationRef: string, now: string, signal: AbortSignal) {
    const c = this.#config, at = instant(now), lower = at - c.lookBackDays * 86_400_000;
    if (!Number.isFinite(at) || signal.aborted) return denied();
    const proof = await awaitUntilAbort(this.#proof.verifyPatient(c.scope, verificationRef, now), signal);
    if (!proof?.ok || signal.aborted || !id(proof.value.patientRef) || proof.value.verificationRef !== verificationRef ||
        ["tenantId", "clinicId", "locationId"].some(key => proof.value.scope[key as keyof LocationScope] !== c.scope[key as keyof LocationScope]) ||
        !Number.isFinite(instant(proof.value.expiresAt)) || instant(proof.value.expiresAt) <= at + 120_000) return denied();
    const patient = proof.value;
    try {
      const business = await this.#get(`/businesses/${c.businessId}`, signal), value = business.ok && record(business.value);
      if (!value || String(value.id) !== c.businessId || value.archived_at || value.time_zone_identifier !== c.timeZone) return denied();
      let total: number | undefined, last = Infinity, latest: number | undefined, complete = false;
      const seen = new Set<string>(), practitioners = new Set<string>();
      for (let page = 1; page <= 5; page++) {
        const query = new URLSearchParams({ page: String(page), per_page: "100", sort: "starts_at:desc" });
        for (const filter of [`patient_id:=${patient.patientRef}`, `business_id:=${c.businessId}`, `starts_at:>${new Date(lower).toISOString()}`, `starts_at:<${now}`, `ends_at:<${now}`]) query.append("q[]", filter);
        const fetched = await this.#get(`/individual_appointments?${query}`, signal), body = fetched.ok && record(fetched.value);
        if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 || !Array.isArray(body.individual_appointments) || body.individual_appointments.length > 100 ||
            total !== undefined && total !== body.total_entries) return denied();
        total = Number(body.total_entries);
        if (!body.individual_appointments.length && seen.size < total) return denied();
        for (const item of body.individual_appointments) {
          const row = record(item), start = instant(row?.starts_at), end = instant(row?.ends_at), practitioner = self(row?.practitioner);
          const practitionerId = typeof practitioner === "string" && practitioner.startsWith(`${this.#base}/practitioners/`) ? practitioner.slice(`${this.#base}/practitioners/`.length) : undefined;
          if (!row || !id(row.id) || seen.has(row.id) || self(row.patient) !== `${this.#base}/patients/${patient.patientRef}` || self(row.business) !== `${this.#base}/businesses/${c.businessId}` ||
              !id(practitionerId) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start <= lower || start >= at || end >= at || start > last ||
              ![null, false, true].includes(row.did_not_arrive as boolean | null) || ["cancelled_at", "archived_at", "deleted_at"].some(key => row[key] !== null && !Number.isFinite(instant(row[key])))) return denied();
          last = start; seen.add(row.id);
          if (row.cancelled_at || row.archived_at || row.deleted_at || row.did_not_arrive === true) continue;
          if (latest === undefined) latest = start;
          if (start === latest) practitioners.add(practitionerId);
        }
        if (seen.size > total) return denied();
        if (seen.size === total || latest !== undefined && last < latest) { complete = true; break; }
      }
      if (!complete || signal.aborted) return denied();
      let result: PreviousPractitionerResult;
      if (latest === undefined) result = { kind: "none" };
      else if (practitioners.size !== 1) result = { kind: "ambiguous" };
      else {
        const practitionerId = [...practitioners][0]!, response = await this.#get(`/practitioners/${practitionerId}`, signal), row = response.ok && record(response.value);
        if (!row || String(row.id) !== practitionerId || !normalizedSpokenName(row.display_name)) return denied();
        result = { kind: "found", practitionerName: row.display_name as string };
      }
      const after = await awaitUntilAbort(this.#proof.verifyPatient(c.scope, verificationRef, now), signal);
      if (!after?.ok || signal.aborted || after.value.patientRef !== patient.patientRef || after.value.expiresAt !== patient.expiresAt) return denied();
      return ok({ result, patient: Object.freeze({ ...patient, scope: Object.freeze({ ...patient.scope }) }) as VerifiedPatient });
    } catch { return denied(); }
  }
}
