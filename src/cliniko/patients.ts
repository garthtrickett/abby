import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import { claimClinikoBudget, ClinikoReadBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { normalizePatientPhone } from "./phone-number.ts";

export type ClinikoClinicScope = Pick<LocationScope, "tenantId" | "clinicId">;
export type ClinikoPatientConfig = Readonly<{
  scope: ClinikoClinicScope;
  apiKey: string;
  contactEmail: string;
  rateBudget?: ClinikoRequestBudget;
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
export type ClinikoPhoneSnapshot = Readonly<{
  scope: ClinikoClinicScope;
  observedAt: string;
  links: readonly Readonly<{ normalizedPhone: string; patientId: string }>[];
}>;
export type ClinikoPhonePage = Readonly<{
  page: number;
  totalEntries: number;
  patientIds: readonly string[];
  links: ClinikoPhoneSnapshot["links"];
}>;

const maxBodyBytes = 1_000_000;
const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const patientIdPattern = /^[1-9][0-9]*$/;

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
  private readonly rateBudget: ClinikoRequestBudget;

  private constructor(config: ClinikoPatientConfig, shard: string, fetchPort: typeof fetch, clock: () => string) {
    this.scope = { tenantId: config.scope.tenantId, clinicId: config.scope.clinicId };
    this.baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.fetchPort = fetchPort;
    this.clock = clock;
    this.rateBudget = config.rateBudget ?? new ClinikoReadBudget();
  }

  static create(config: ClinikoPatientConfig, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()): Result<ClinikoPatientCandidateReader, ClinikoPatientFailure> {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) || !validScope(config.scope) ||
        !validEmail(config.contactEmail) || typeof fetchPort !== "function" || typeof clock !== "function" ||
        (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget))) {
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
    const limited = await claimClinikoBudget(this.rateBudget);
    if (limited) return err(limited);
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}/patients?${query}`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: this.authorization, "User-Agent": this.userAgent },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { return err({ kind: "unavailable" }); }
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 429) return err(await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset")));
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

  /** Yields one fully validated page at a time so the index can checkpoint before fetching the next page. */
  async *phonePages(scope: ClinikoClinicScope, countryCallingCode: string, startPage = 1,
                    maxPatients = 100_000, waitUntil?: (resetAt: string) => Promise<void>):
    AsyncGenerator<Result<ClinikoPhonePage, ClinikoPatientFailure>> {
    if (!validScope(scope) || scope.tenantId !== this.scope.tenantId || scope.clinicId !== this.scope.clinicId) {
      yield err({ kind: "scopeMismatch" }); return;
    }
    if (!/^[1-9][0-9]{0,2}$/.test(countryCallingCode) || !Number.isSafeInteger(maxPatients) ||
        maxPatients < 1 || maxPatients > 100_000 || !Number.isSafeInteger(startPage) ||
        startPage < 1 || startPage > Math.ceil(maxPatients / 100)) {
      yield err({ kind: "invalidQuery" }); return;
    }
    let totalEntries: number | undefined;
    let rateWaits = 0;
    const pause = async (resetAt: string | undefined): Promise<boolean> => {
      if (!waitUntil || !resetAt || rateWaits >= 12) return false;
      rateWaits += 1;
      try { await waitUntil(resetAt); return true; }
      catch { return false; }
    };
    for (let page = startPage; ;) {
      const limited = await claimClinikoBudget(this.rateBudget);
      if (limited) {
        if (limited.kind === "rateLimited" && await pause(limited.resetAt)) continue;
        yield err(limited); return;
      }
      const query = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
      let response: Response;
      try {
        response = await this.fetchPort(`${this.baseUrl}/patients?${query}`, {
          method: "GET", headers: { Accept: "application/json", Authorization: this.authorization,
            "User-Agent": this.userAgent }, redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch { yield err({ kind: "unavailable" }); return; }
      if (response.status === 401 || response.status === 403) { yield err({ kind: "forbidden" }); return; }
      if (response.status === 429) {
        const limited = await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset"));
        if (await pause(limited.resetAt)) continue;
        yield err(limited); return;
      }
      if (response.status >= 500 || response.status === 404) { yield err({ kind: "unavailable" }); return; }
      if (response.status !== 200) { yield err({ kind: "malformed" }); return; }
      const parsed = await boundedJson(response);
      if (!parsed.ok) { yield parsed; return; }
      const body = record(parsed.value);
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
          Number(body.total_entries) > maxPatients || !Array.isArray(body.patients) || body.patients.length > 100 ||
          (totalEntries !== undefined && totalEntries !== body.total_entries)) {
        yield err({ kind: "tooManyResults" }); return;
      }
      totalEntries = Number(body.total_entries);
      const expected = Math.min(100, Math.max(0, totalEntries - (page - 1) * 100));
      if (body.patients.length !== expected) { yield err({ kind: "malformed" }); return; }
      const patientIds: string[] = [];
      const links: Array<{ normalizedPhone: string; patientId: string }> = [];
      const seenIds = new Set<string>();
      const seenLinks = new Set<string>();
      for (const candidate of body.patients) {
        const patient = record(candidate);
        if (!patient || typeof patient.id !== "string" || !patientIdPattern.test(patient.id) ||
            seenIds.has(patient.id) || (patient.archived_at !== null && patient.archived_at !== undefined &&
              typeof patient.archived_at !== "string") ||
            (patient.patient_phone_numbers !== null && !Array.isArray(patient.patient_phone_numbers))) {
          yield err({ kind: "malformed" }); return;
        }
        seenIds.add(patient.id);
        patientIds.push(patient.id);
        if (patient.archived_at !== null && patient.archived_at !== undefined) continue;
        const phones = Array.isArray(patient.patient_phone_numbers) ? patient.patient_phone_numbers : [];
        for (const value of phones) {
          const phone = record(value);
          if (!phone || (phone.number !== null && typeof phone.number !== "string") ||
              (phone.phone_type !== null && phone.phone_type !== undefined && typeof phone.phone_type !== "string")) {
            yield err({ kind: "malformed" }); return;
          }
          if (typeof phone.phone_type === "string" && phone.phone_type.toLowerCase() === "fax") continue;
          const normalizedPhone = normalizePatientPhone(String(phone.number ?? ""), countryCallingCode);
          if (normalizedPhone) {
            const key = `${normalizedPhone}\0${patient.id}`;
            if (!seenLinks.has(key)) {
              seenLinks.add(key);
              links.push({ normalizedPhone, patientId: patient.id });
              if (links.length > 100_000) { yield err({ kind: "tooManyResults" }); return; }
            }
          }
        }
      }
      yield ok({ page, totalEntries, patientIds, links });
      if (page * 100 >= totalEntries) return;
      if (page * 100 >= maxPatients || expected < 100) { yield err({ kind: "malformed" }); return; }
      page += 1;
    }
  }

  /** Legacy bounded collector used by direct synthetic callers. */
  async readPhoneSnapshot(scope: ClinikoClinicScope, countryCallingCode: string, maxPatients = 100_000,
                          waitUntil?: (resetAt: string) => Promise<void>):
    Promise<Result<ClinikoPhoneSnapshot, ClinikoPatientFailure>> {
    const links: Array<{ normalizedPhone: string; patientId: string }> = [];
    const seenIds = new Set<string>();
    for await (const page of this.phonePages(scope, countryCallingCode, 1, maxPatients, waitUntil)) {
      if (!page.ok) return page;
      for (const id of page.value.patientIds) {
        if (seenIds.has(id)) return err({ kind: "malformed" });
        seenIds.add(id);
      }
      links.push(...page.value.links);
      if (links.length > 100_000) return err({ kind: "tooManyResults" });
    }
    let observedAt: string;
    try { observedAt = this.clock(); }
    catch { return err({ kind: "unavailable" }); }
    if (!Number.isFinite(Date.parse(observedAt))) return err({ kind: "unavailable" });
    return ok({ scope: structuredClone(this.scope), observedAt, links });
  }

  /** Rechecks an indexed candidate against Cliniko before any identity workflow uses it. */
  async hasCurrentPhone(scope: ClinikoClinicScope, patientId: string, normalizedPhone: string, countryCallingCode: string):
    Promise<Result<boolean, ClinikoPatientFailure>> {
    if (!validScope(scope) || scope.tenantId !== this.scope.tenantId || scope.clinicId !== this.scope.clinicId) {
      return err({ kind: "scopeMismatch" });
    }
    if (!patientIdPattern.test(patientId) || !/^\+[1-9][0-9]{7,14}$/.test(normalizedPhone) ||
        !/^[1-9][0-9]{0,2}$/.test(countryCallingCode)) return err({ kind: "invalidQuery" });
    const limited = await claimClinikoBudget(this.rateBudget);
    if (limited) return err(limited);
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}/patients/${patientId}`, {
        method: "GET", headers: { Accept: "application/json", Authorization: this.authorization,
          "User-Agent": this.userAgent }, redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { return err({ kind: "unavailable" }); }
    if (response.status === 404) return ok(false);
    if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
    if (response.status === 429) return err(await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset")));
    if (response.status >= 500) return err({ kind: "unavailable" });
    if (response.status !== 200) return err({ kind: "malformed" });
    const parsed = await boundedJson(response);
    if (!parsed.ok) return parsed;
    const patient = record(parsed.value);
    if (!patient || patient.id !== patientId ||
        (patient.archived_at !== null && patient.archived_at !== undefined && typeof patient.archived_at !== "string") ||
        (patient.patient_phone_numbers !== null && !Array.isArray(patient.patient_phone_numbers))) {
      return err({ kind: "malformed" });
    }
    if (patient.archived_at !== null && patient.archived_at !== undefined) return ok(false);
    const phones = Array.isArray(patient.patient_phone_numbers) ? patient.patient_phone_numbers : [];
    for (const value of phones) {
      const phone = record(value);
      if (!phone || (phone.number !== null && typeof phone.number !== "string") ||
          (phone.phone_type !== null && phone.phone_type !== undefined && typeof phone.phone_type !== "string")) {
        return err({ kind: "malformed" });
      }
      if (typeof phone.phone_type === "string" && phone.phone_type.toLowerCase() === "fax") continue;
      if (normalizePatientPhone(String(phone.number ?? ""), countryCallingCode) === normalizedPhone) return ok(true);
    }
    return ok(false);
  }
}
