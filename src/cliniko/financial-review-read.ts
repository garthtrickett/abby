import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError, ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { decodeClinikoFinancialIntent } from "./financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { validRecallDate, validRecallMarker } from "./recall-note.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { financialConfigShard, financialSelection, financialRecordInstant as instant } from "./internal/financial-record-context.ts";
import type { ClinikoFinancialReviewConfig, ClinikoFinancialReviewSelection } from "./internal/financial-record-context.ts";
export type { ClinikoFinancialReviewConfig, ClinikoFinancialReviewSelection } from "./internal/financial-record-context.ts";

export type ClinikoFinancialReviewBinding = Readonly<{ recallRef: string; actionRef: string }>;
/** Supplied by the trusted clinic financial owner, never by caller/model input.
 * Permission binds the configured location/account/type and exact native record.
 * The record's own note cannot establish this permission or location ownership. */
export type ClinikoFinancialReviewPermission = Readonly<{
  allows(query: ClinikoFinancialReviewSelection & ClinikoFinancialReviewBinding, signal: AbortSignal): Promise<boolean>;
}>;
export type ClinikoFinancialReviewFailure = Readonly<{
  kind: "invalidConfig" | "invalidQuery" | "forbidden" | "rateLimited" | "unavailable" | "malformed" | "mismatched";
  resetAt?: string;
}>;
/** Transient private context only. Even an exact pending record is not immutable
 * history, observed booking acknowledgement, payment truth or an effect permit.
 * Recalled/archived flags are workflow context, not completion or received money. */
export type ClinikoFinancialReviewContext = Readonly<{
  kind: "context"; recallRef: string; observedAt: string; createdAt: string; updatedAt: string;
  recallAt: string; recalled: boolean; archivedAt: string | null; intent: ClinikoFinancialIntent;
}>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
class ReadFailure extends Error {
  readonly kind: ClinikoFinancialReviewFailure["kind"];
  constructor(kind: ClinikoFinancialReviewFailure["kind"]) { super("Financial review unavailable"); this.kind = kind; }
}
function discardBody(response: Response | undefined): void {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* Cleanup cannot disclose an upstream error. */ }
}

/** One exact GET with independent current financial-owner permission. No list/
 * latest/patient fallback, retry, effect, SQL persistence or public route.
 * Native contract: https://docs.api.cliniko.com/openapi/recall/getrecall-get */
export class ClinikoFinancialReviewReader {
  readonly #selection: ClinikoFinancialReviewSelection;
  readonly #base: string;
  readonly #authorization: string;
  readonly #agent: string;
  readonly #permission: ClinikoFinancialReviewPermission;
  readonly #budget: ClinikoRequestBudget;
  readonly #fetch: typeof fetch;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  private constructor(config: ClinikoFinancialReviewConfig, permission: ClinikoFinancialReviewPermission,
                      port: typeof fetch, shard: string) {
    this.#selection = financialSelection(config);
    this.#base = `https://api.${shard}.cliniko.com/v1`;
    this.#authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.#agent = `Abby (${config.contactEmail})`;
    this.#permission = Object.freeze({ allows: permission.allows.bind(permission) });
    this.#budget = config.rateBudget; this.#fetch = port;
    this.#clock = config.clock ?? (() => new Date().toISOString()); this.#deadlineMs = config.deadlineMs ?? 15_000;
  }

  static create(config: ClinikoFinancialReviewConfig, permission: ClinikoFinancialReviewPermission,
                port: typeof fetch = fetch): Result<ClinikoFinancialReviewReader, ClinikoFinancialReviewFailure> {
    const shard = financialConfigShard(config, port);
    if (!shard || typeof permission?.allows !== "function") return err({ kind: "invalidConfig" });
    return ok(new ClinikoFinancialReviewReader(config, permission, port, shard));
  }

  selection(): ClinikoFinancialReviewSelection { return this.#selection; }

  async read(binding: ClinikoFinancialReviewBinding, external: AbortSignal):
    Promise<Result<ClinikoFinancialReviewContext, ClinikoFinancialReviewFailure>> {
    const wanted = Object.freeze({ recallRef: binding?.recallRef, actionRef: binding?.actionRef });
    const nativeId = typeof wanted.recallRef === "string" ? /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(wanted.recallRef)?.[1] : undefined;
    if (!nativeId || !validRecallMarker(wanted.actionRef)) return err({ kind: "invalidQuery" });
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#deadlineMs);
    const signal = AbortSignal.any([external, deadline.signal]), started = performance.now();
    const query = Object.freeze({ ...this.#selection, ...wanted });
    let ownedResponse: Response | undefined, bodyOwned = false;
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const value = await awaitUntilAbort(task, signal);
      if (value === undefined || signal.aborted || performance.now() - started > this.#deadlineMs) throw new ReadFailure("unavailable");
      return value;
    };
    const permit = async () => {
      if (await wait(Promise.resolve().then(() => this.#permission.allows(query, signal))) !== true) throw new ReadFailure("forbidden");
    };
    try {
      const beganAt = instant(this.#clock()); if (!beganAt) throw new ReadFailure("unavailable");
      await permit();
      const limited = await wait(claimClinikoBudget(this.#budget)); if (limited) return err(limited);
      // Quota admission may have waited. An earlier permission cannot authorize
      // the subsequent protected read after financial access has been withdrawn.
      await permit();
      const response = await wait(this.#fetch(`${this.#base}/recalls/${nativeId}`, { method: "GET", redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: this.#authorization, "User-Agent": this.#agent } }).then(value => {
        ownedResponse = value;
        if (signal.aborted) discardBody(value);
        return value;
      }));
      if (response.status === 429) return err(await wait(observeCliniko429(this.#budget, response.headers.get("X-RateLimit-Reset"))));
      if (response.status === 401 || response.status === 403) return err({ kind: "forbidden" });
      if (response.status !== 200) return err({ kind: "unavailable" });
      bodyOwned = true;
      const bytes = await ownedBodyBytes(response.body, 1_000_000, signal);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new ReadFailure("malformed"); }
      const row = record(body), decoded = decodeClinikoFinancialIntent(row?.notes);
      const createdAt = instant(row?.created_at), updatedAt = instant(row?.updated_at);
      const archivedAt = row?.archived_at === null ? null : instant(row?.archived_at);
      if (!row || typeof row.recalled !== "boolean" || !validRecallDate(row.recall_at) ||
          !createdAt || !updatedAt || archivedAt === undefined || createdAt > updatedAt ||
          archivedAt !== null && archivedAt < createdAt || !decoded.ok) throw new ReadFailure("malformed");
      const intent = decoded.value, selected = this.#selection;
      if (row.id !== nativeId || record(row.links)?.self !== `${this.#base}/recalls/${nativeId}` ||
          record(record(row.patient)?.links)?.self !== `${this.#base}/patients/${intent.patientId}` ||
          record(record(row.recall_type)?.links)?.self !== `${this.#base}/recall_types/${selected.recallTypeId}` ||
          intent.actionRef !== wanted.actionRef || intent.scope.tenantId !== selected.scope.tenantId ||
          intent.scope.clinicId !== selected.scope.clinicId || intent.scope.locationId !== selected.scope.locationId ||
          intent.businessId !== selected.businessId || intent.credentialFingerprint !== selected.credentialFingerprint ||
          intent.stripe.accountRef !== selected.stripe.accountRef || intent.stripe.livemode !== selected.stripe.livemode) throw new ReadFailure("mismatched");
      await permit();
      const observedAt = instant(this.#clock());
      if (!observedAt || observedAt < beganAt || Date.parse(updatedAt) > Date.parse(observedAt) + 30_000 ||
          archivedAt !== null && Date.parse(archivedAt) > Date.parse(observedAt) + 30_000 ||
          signal.aborted || performance.now() - started > this.#deadlineMs) throw new ReadFailure("unavailable");
      return ok({ kind: "context", recallRef: wanted.recallRef, observedAt, createdAt, updatedAt, recallAt: row.recall_at,
        recalled: row.recalled, archivedAt, intent });
    } catch (error) {
      return err({ kind: error instanceof ReadFailure || error instanceof OwnedBodyError ? error.kind : "unavailable" });
    } finally {
      clearTimeout(timer); deadline.abort();
      if (!bodyOwned) discardBody(ownedResponse);
    }
  }
}
