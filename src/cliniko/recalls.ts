import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { claimClinikoBudget, ClinikoReadBudget, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import type { ClinikoClinicScope } from "./patients.ts";
import { matchesRecallMarker, validRecallDate, validRecallMarker } from "./recall-note.ts";

export type ClinikoRecallFailure = Readonly<{
  kind: "invalidConfig" | "scopeMismatch" | "invalidQuery" | "forbidden" | "rateLimited" |
    "unavailable" | "malformed" | "tooManyResults";
  resetAt?: string;
}>;
export type ClinikoRecallMatch = Readonly<{ scope: ClinikoClinicScope; observedAt: string }> & (
  | Readonly<{ kind: "none" | "ambiguous" | "mismatch" }>
  | Readonly<{ kind: "one"; recallRef: string; recalled: boolean; archived: boolean }>
);
export type ClinikoRecallConfig = Readonly<{
  scope: ClinikoClinicScope;
  apiKey: string;
  contactEmail: string;
  rateBudget?: ClinikoRequestBudget;
}>;
export type ClinikoRecallExpectation = Readonly<{ notes: string; recallTypeId: string; recallAt: string }>;
/** Counts only; no recall, patient, note, or marker leaves this read boundary. */
export type ClinikoRecallQueuePulse = Readonly<{
  scope: ClinikoClinicScope;
  observedAt: string;
  throughDate: string;
  scanned: number;
  pending: number;
  overdue: number;
  markedRecalled: number;
}>;

const idPattern = /^[1-9][0-9]*$/;
const emailPattern = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const pageSize = 100;
const maxPages = 5;
const maxBodyBytes = 1_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validScope(value: unknown): value is ClinikoClinicScope {
  const scope = record(value);
  return !!scope && [scope.tenantId, scope.clinicId]
    .every(part => typeof part === "string" && !!part.trim() && part.length <= 256);
}

export async function boundedRecallJson(response: Response): Promise<Result<unknown, ClinikoRecallFailure>> {
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

/** A read-only, bounded lookup. A miss cannot authorize retrying an uncertain POST. */
export class ClinikoRecallReader {
  private readonly scope: ClinikoClinicScope;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly rateBudget: ClinikoRequestBudget;
  private readonly fetchPort: typeof fetch;
  private readonly clock: () => string;

  private constructor(config: ClinikoRecallConfig, fetchPort: typeof fetch, clock: () => string, shard: string) {
    this.scope = { tenantId: config.scope.tenantId, clinicId: config.scope.clinicId };
    this.baseUrl = `https://api.${shard}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.rateBudget = config.rateBudget ?? new ClinikoReadBudget();
    this.fetchPort = fetchPort;
    this.clock = clock;
  }

  static create(config: ClinikoRecallConfig, fetchPort: typeof fetch = fetch,
                clock: () => string = () => new Date().toISOString()): Result<ClinikoRecallReader, ClinikoRecallFailure> {
    const shard = typeof config?.apiKey === "string" ? config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)?.[1] : undefined;
    if (!shard || !config.apiKey.slice(0, -(shard.length + 1)) || /[\u0000-\u001f\u007f]/.test(config.apiKey) ||
        !validScope(config.scope) || typeof config.contactEmail !== "string" ||
        config.contactEmail.length > 254 || !emailPattern.test(config.contactEmail) ||
        typeof fetchPort !== "function" || typeof clock !== "function" ||
        (config.rateBudget !== undefined && !isClinikoRequestBudget(config.rateBudget))) {
      return err({ kind: "invalidConfig" });
    }
    return ok(new ClinikoRecallReader(config, fetchPort, clock, shard));
  }

  /** Reads one patient's active or archived recalls and matches an exact random marker in notes. */
  async findByMarker(scope: ClinikoClinicScope, patientId: string, marker: string, archived = false,
                     expected?: ClinikoRecallExpectation):
    Promise<Result<ClinikoRecallMatch, ClinikoRecallFailure>> {
    const expectedValue = expected === undefined ? undefined : record(expected);
    if (!validScope(scope) || scope.tenantId !== this.scope.tenantId || scope.clinicId !== this.scope.clinicId) {
      return err({ kind: "scopeMismatch" });
    }
    if (typeof patientId !== "string" || !idPattern.test(patientId) ||
        !validRecallMarker(marker) || typeof archived !== "boolean" ||
        (expected !== undefined && (!expectedValue || typeof expectedValue.notes !== "string" ||
          !expectedValue.notes.startsWith(`Abby request ${marker}\n`) ||
          typeof expectedValue.recallTypeId !== "string" || !idPattern.test(expectedValue.recallTypeId) ||
          expectedValue.recallTypeId.length > 19 || !validRecallDate(expectedValue.recallAt)))) {
      return err({ kind: "invalidQuery" });
    }
    let observedAt: string;
    try { observedAt = this.clock(); }
    catch { return err({ kind: "unavailable" }); }
    if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) return err({ kind: "unavailable" });

    const seen = new Set<string>();
    const matches: Array<{ id: string; notes: string | null; recalled: boolean; archived: boolean;
      recallAt: unknown; recallTypeLink: unknown }> = [];
    let totalEntries: number | undefined;
    let lastId = 0n;
    for (let page = 1; page <= maxPages; page += 1) {
      const limited = await claimClinikoBudget(this.rateBudget);
      if (limited) return err(limited);
      const query = new URLSearchParams({ page: String(page), per_page: String(pageSize), sort: "id:asc" });
      query.append("q[]", `patient_id:=${patientId}`);
      if (archived) query.append("q[]", "archived_at:*");
      let response: Response;
      try {
        response = await this.fetchPort(`${this.baseUrl}/recalls?${query}`, {
          method: "GET", headers: { Accept: "application/json", Authorization: this.authorization,
            "User-Agent": this.userAgent }, redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch { return err({ kind: "unavailable" }); }
      if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
      if (response.status === 429) return err(await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset")));
      if (response.status >= 500 || response.status === 404) return err({ kind: "unavailable" });
      if (response.status !== 200) return err({ kind: "malformed" });
      const parsed = await boundedRecallJson(response);
      if (!parsed.ok) return parsed;
      const body = record(parsed.value);
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
          Number(body.total_entries) > pageSize * maxPages || !Array.isArray(body.recalls) ||
          (totalEntries !== undefined && totalEntries !== body.total_entries)) return err({ kind: "tooManyResults" });
      totalEntries = Number(body.total_entries);
      const expected = Math.min(pageSize, Math.max(0, totalEntries - (page - 1) * pageSize));
      if (body.recalls.length !== expected) return err({ kind: "malformed" });
      for (const item of body.recalls) {
        const recall = record(item);
        const patient = record(recall?.patient);
        const links = record(patient?.links);
        if (!recall || typeof recall.id !== "string" || !idPattern.test(recall.id) || recall.id.length > 19 ||
            seen.has(recall.id) ||
            links?.self !== `${this.baseUrl}/patients/${patientId}` ||
            (recall.notes !== null && typeof recall.notes !== "string") ||
            (recall.recalled !== null && typeof recall.recalled !== "boolean") ||
            (recall.archived_at !== null && typeof recall.archived_at !== "string") ||
            (archived && recall.archived_at === null) || (!archived && recall.archived_at !== null)) {
          return err({ kind: "malformed" });
        }
        const numericId = BigInt(recall.id);
        if (numericId <= lastId) return err({ kind: "malformed" });
        lastId = numericId;
        seen.add(recall.id);
        if (matchesRecallMarker(recall.notes as string | null, marker)) {
          const type = record(recall.recall_type);
          const typeLinks = record(type?.links);
          matches.push({ id: recall.id, notes: recall.notes as string | null,
            recalled: recall.recalled === true, archived, recallAt: recall.recall_at,
            recallTypeLink: typeLinks?.self });
        }
      }
      if (seen.size === totalEntries) break;
    }
    if (seen.size !== totalEntries) return err({ kind: "tooManyResults" });
    const base = { scope: structuredClone(this.scope), observedAt };
    if (matches.length === 0) return ok({ ...base, kind: "none" });
    if (matches.length > 1) return ok({ ...base, kind: "ambiguous" });
    if (expected !== undefined && (matches[0]!.notes !== expected.notes ||
        matches[0]!.recallAt !== expected.recallAt ||
        matches[0]!.recallTypeLink !== `${this.baseUrl}/recall_types/${expected.recallTypeId}`)) {
      return ok({ ...base, kind: "mismatch" });
    }
    return ok({ ...base, kind: "one", recallRef: `cliniko:recall:${matches[0]!.id}`,
      recalled: matches[0]!.recalled, archived: matches[0]!.archived });
  }

  /** Read-only account scan for one configured recall type. Incomplete scans never yield partial counts. */
  async queuePulse(scope: ClinikoClinicScope, recallTypeId: string, throughDate: string):
    Promise<Result<ClinikoRecallQueuePulse, ClinikoRecallFailure>> {
    if (!validScope(scope) || scope.tenantId !== this.scope.tenantId || scope.clinicId !== this.scope.clinicId) {
      return err({ kind: "scopeMismatch" });
    }
    if (typeof recallTypeId !== "string" || !idPattern.test(recallTypeId) || recallTypeId.length > 19 ||
        !validRecallDate(throughDate)) return err({ kind: "invalidQuery" });
    let observedAt: string;
    try { observedAt = this.clock(); }
    catch { return err({ kind: "unavailable" }); }
    if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) {
      return err({ kind: "unavailable" });
    }

    let totalEntries: number | undefined;
    let scanned = 0;
    let pending = 0;
    let overdue = 0;
    let markedRecalled = 0;
    let lastId = 0n;
    for (let page = 1; page <= maxPages; page += 1) {
      const limited = await claimClinikoBudget(this.rateBudget);
      if (limited) return err(limited);
      const query = new URLSearchParams({ page: String(page), per_page: String(pageSize), sort: "id:asc" });
      let response: Response;
      try {
        response = await this.fetchPort(`${this.baseUrl}/recalls?${query}`, {
          method: "GET", headers: { Accept: "application/json", Authorization: this.authorization,
            "User-Agent": this.userAgent }, redirect: "error", signal: AbortSignal.timeout(15_000),
        });
      } catch { return err({ kind: "unavailable" }); }
      if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
      if (response.status === 429) {
        return err(await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset")));
      }
      if (response.status >= 500 || response.status === 404) return err({ kind: "unavailable" });
      if (response.status !== 200) return err({ kind: "malformed" });
      const parsed = await boundedRecallJson(response);
      if (!parsed.ok) return parsed;
      const body = record(parsed.value);
      if (!body || !Number.isSafeInteger(body.total_entries) || Number(body.total_entries) < 0 ||
          Number(body.total_entries) > pageSize * maxPages || !Array.isArray(body.recalls) ||
          (totalEntries !== undefined && totalEntries !== body.total_entries)) return err({ kind: "tooManyResults" });
      totalEntries = Number(body.total_entries);
      const expected = Math.min(pageSize, Math.max(0, totalEntries - (page - 1) * pageSize));
      if (body.recalls.length !== expected) return err({ kind: "malformed" });
      for (const item of body.recalls) {
        const recall = record(item);
        const patientLink = record(record(recall?.patient)?.links)?.self;
        const typeLink = record(record(recall?.recall_type)?.links)?.self;
        if (!recall || typeof recall.id !== "string" || !idPattern.test(recall.id) ||
            recall.id.length > 19 || BigInt(recall.id) <= lastId ||
            typeof patientLink !== "string" ||
            !patientLink.startsWith(`${this.baseUrl}/patients/`) ||
            !idPattern.test(patientLink.slice(`${this.baseUrl}/patients/`.length)) ||
            typeof typeLink !== "string" || !typeLink.startsWith(`${this.baseUrl}/recall_types/`) ||
            !idPattern.test(typeLink.slice(`${this.baseUrl}/recall_types/`.length)) ||
            recall.archived_at !== null || !validRecallDate(recall.recall_at) ||
            (recall.recalled !== true && recall.recalled !== false && recall.recalled !== null)) {
          return err({ kind: "malformed" });
        }
        lastId = BigInt(recall.id);
        scanned += 1;
        if (typeLink !== `${this.baseUrl}/recall_types/${recallTypeId}`) continue;
        if (recall.recalled === true) markedRecalled += 1;
        else {
          pending += 1;
          if (recall.recall_at < throughDate) overdue += 1;
        }
      }
      if (scanned === totalEntries) break;
    }
    if (scanned !== totalEntries) return err({ kind: "tooManyResults" });
    return ok({ scope: structuredClone(this.scope), observedAt, throughDate,
      scanned, pending, overdue, markedRecalled });
  }
}
