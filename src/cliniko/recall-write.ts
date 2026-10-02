import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { ClinikoClinicScope } from "./patients.ts";
import { formatRecallNote, validRecallDate, validRecallMarker, validRecallSummary } from "./recall-note.ts";
import { claimClinikoBudget, ClinikoReadBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { boundedRecallJson, ClinikoRecallReader } from "./recalls.ts";
import type { ClinikoRecallConfig, ClinikoRecallFailure, ClinikoRecallMatch } from "./recalls.ts";

export type ClinikoRecallWriteRequest = Readonly<{
  scope: ClinikoClinicScope;
  patientId: string;
  recallTypeId: string;
  recallAt: string;
  marker: string;
  summary: string;
}>;

export type ClinikoRecallWriteOutcome =
  | Readonly<{ kind: "accepted"; recallRef: string }>
  | Readonly<{ kind: "uncertain" }>;

const idPattern = /^[1-9][0-9]{0,18}$/;
const maxProcessAttempts = 10_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** One process-local send attempt. A lost response never triggers another POST. */
export class ClinikoRecallWriter {
  private readonly scope: ClinikoClinicScope;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly userAgent: string;
  private readonly rateBudget: ClinikoRequestBudget;
  private readonly fetchPort: typeof fetch;
  private readonly reader: ClinikoRecallReader;
  private readonly attempted = new Set<string>();

  private constructor(config: ClinikoRecallConfig, reader: ClinikoRecallReader, fetchPort: typeof fetch) {
    this.scope = { ...config.scope };
    this.baseUrl = `https://api.${config.apiKey.match(/-([a-z]{2}[0-9]{1,2})$/)![1]}.cliniko.com/v1`;
    this.authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.userAgent = `Abby (${config.contactEmail})`;
    this.rateBudget = config.rateBudget!;
    this.fetchPort = fetchPort;
    this.reader = reader;
  }

  static create(config: ClinikoRecallConfig, fetchPort: typeof fetch = fetch): Result<ClinikoRecallWriter, ClinikoRecallFailure> {
    if (!config || typeof config !== "object") return err({ kind: "invalidConfig" });
    const shared = { ...config, rateBudget: config?.rateBudget ?? new ClinikoReadBudget() };
    const reader = ClinikoRecallReader.create(shared, fetchPort);
    return reader.ok ? ok(new ClinikoRecallWriter(shared, reader.value, fetchPort)) : reader;
  }

  async openOnce(request: ClinikoRecallWriteRequest):
    Promise<Result<ClinikoRecallWriteOutcome, ClinikoRecallFailure>> {
    const scope = record(request?.scope);
    if (!scope || scope.tenantId !== this.scope.tenantId || scope.clinicId !== this.scope.clinicId) {
      return err({ kind: "scopeMismatch" });
    }
    if (typeof request.patientId !== "string" || !idPattern.test(request.patientId) ||
        typeof request.recallTypeId !== "string" || !idPattern.test(request.recallTypeId) ||
        !validRecallDate(request.recallAt) || !validRecallMarker(request.marker) || !validRecallSummary(request.summary)) {
      return err({ kind: "invalidQuery" });
    }
    if (this.attempted.has(request.marker)) return err({ kind: "invalidQuery" });
    if (this.attempted.size >= maxProcessAttempts) return err({ kind: "unavailable" });
    // Claim before the asynchronous budget reservation so concurrent callers
    // cannot both pass the marker check and send duplicate recalls.
    this.attempted.add(request.marker);
    const limited = await claimClinikoBudget(this.rateBudget);
    if (limited) {
      // No provider request was sent; the caller may safely try again later.
      this.attempted.delete(request.marker);
      return err(limited);
    }
    const notes = formatRecallNote(request.marker, request.summary);
    let response: Response;
    try {
      response = await this.fetchPort(`${this.baseUrl}/recalls`, {
        method: "POST", headers: { Accept: "application/json", Authorization: this.authorization,
          "Content-Type": "application/json", "User-Agent": this.userAgent },
        body: JSON.stringify({ patient_id: request.patientId, recall_type_id: request.recallTypeId,
          recall_at: request.recallAt, notes, recalled: false }),
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch { return ok({ kind: "uncertain" }); }
    if (response.status === 429) await observeCliniko429(this.rateBudget, response.headers.get("X-RateLimit-Reset"));
    if (response.status !== 201) return ok({ kind: "uncertain" });
    const parsed = await boundedRecallJson(response);
    if (!parsed.ok) return ok({ kind: "uncertain" });
    const row = record(parsed.value);
    const patient = record(row?.patient);
    const type = record(row?.recall_type);
    const patientLinks = record(patient?.links);
    const typeLinks = record(type?.links);
    if (!row || typeof row.id !== "string" || !idPattern.test(row.id) ||
        row.notes !== notes || row.recall_at !== request.recallAt || row.recalled !== false ||
        row.archived_at !== null ||
        patientLinks?.self !== `${this.baseUrl}/patients/${request.patientId}` ||
        typeLinks?.self !== `${this.baseUrl}/recall_types/${request.recallTypeId}`) {
      return ok({ kind: "uncertain" });
    }
    return ok({ kind: "accepted", recallRef: `cliniko:recall:${row.id}` });
  }

  /** A miss is only an observation; it never authorizes retrying an uncertain create. */
  observe(request: ClinikoRecallWriteRequest, archived = false):
    Promise<Result<ClinikoRecallMatch, ClinikoRecallFailure>> {
    if (!validRecallMarker(request?.marker) || !validRecallSummary(request?.summary) ||
        !validRecallDate(request?.recallAt)) {
      return Promise.resolve(err({ kind: "invalidQuery" }));
    }
    return this.reader.findByMarker(request.scope, request.patientId, request.marker, archived,
      { notes: formatRecallNote(request.marker, request.summary), recallTypeId: request.recallTypeId,
        recallAt: request.recallAt });
  }
}
