import { err, ok } from "../../core/model.ts";
import type { Result } from "../../core/model.ts";
import { awaitUntilAbort } from "../../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../../shared/owned-body-bytes.ts";
import type { FinancialEffectBarrier } from "../../standalone/financial-effect-barrier.ts";
import { claimClinikoBudget, observeCliniko429 } from "../read-budget.ts";
import type { ClinikoRequestBudget } from "../read-budget.ts";
import { validRecallDate } from "../recall-note.ts";
import { financialRecordInstant, financialSelection } from "./financial-record-context.ts";
import type { ClinikoFinancialReviewConfig, ClinikoFinancialReviewSelection } from "./financial-record-context.ts";

export type FinancialRecordQuery = ClinikoFinancialReviewSelection & Readonly<{
  ownerBinding: string; operation: "retainIntent" | "retainBookingObservation" | "readBookingObservation";
  actionRef: string; financialActionRef: string; patientId: string; intentDigest: string;
  recallRef?: string; intentRecallRef?: string; recallAt?: string;
}>;
/** Independently supplied by the trusted clinic financial service. A note, caller
 * proof, local claim, elapsed lease or signature cannot supply either grant.
 * Readonly observation does not require admission of an effect producer. */
export type FinancialRecordAuthority = Readonly<{
  allows(query: FinancialRecordQuery, signal: AbortSignal): Promise<boolean>;
  producerAdmitted(query: FinancialRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialRecordQuery, signal: AbortSignal): boolean;
}>;
export type FinancialRecordFailure = Readonly<{
  kind: "invalidConfig" | "invalidQuery" | "forbidden" | "alreadyClaimed" | "unavailable" | "rateLimited" | "malformed" | "mismatched";
  resetAt?: string;
}>;
export type NativeFinancialRecord = Readonly<{
  kind: "record"; recallRef: string; notes: string; recallAt: string;
  createdAt: string; updatedAt: string; recalled: boolean; archivedAt: string | null;
}>;
type NativeRequest = Readonly<{ query: FinancialRecordQuery }> & (
  | Readonly<{ method: "POST"; notes: string; recallAt: string; notAfter?: string; notBefore?: string }>
  | Readonly<{ method: "GET"; recallId: string }>
);
type NativeResult = NativeFinancialRecord | Readonly<{ kind: "uncertain" }>;
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const link = (v: unknown) => object(object(v)?.links)?.self;
class RecordFailure extends Error {
  readonly kind: FinancialRecordFailure["kind"];
  constructor(kind: FinancialRecordFailure["kind"]) { super("Financial record unavailable"); this.kind = kind; }
}
function discard(response: Response | undefined): void {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* Only bodies owned by this operation. */ }
}

/** Exact /recalls create/read only. Bounds the whole wait, owns response bytes,
 * shares physical native quota and never retries a dispatched write. Internal:
 * callers must supply canonical family notes and validate the decoded family. */
export class FinancialRecordTransport {
  readonly #selection: ClinikoFinancialReviewSelection;
  readonly #base: string;
  readonly #authorization: string;
  readonly #agent: string;
  readonly #authority: FinancialRecordAuthority;
  readonly #claim: FinancialEffectBarrier["claimOnce"];
  readonly #budget: ClinikoRequestBudget;
  readonly #fetch: typeof fetch;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  constructor(config: ClinikoFinancialReviewConfig, shard: string, authority: FinancialRecordAuthority,
              barrier: FinancialEffectBarrier, port: typeof fetch) {
    this.#selection = financialSelection(config); this.#base = `https://api.${shard}.cliniko.com/v1`;
    this.#authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;
    this.#agent = `Abby (${config.contactEmail})`;
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), producerAdmitted: authority.producerAdmitted.bind(authority), current: authority.current.bind(authority) });
    this.#claim = barrier.claimOnce.bind(barrier); this.#budget = config.rateBudget; this.#fetch = port;
    this.#clock = config.clock ?? (() => new Date().toISOString()); this.#deadlineMs = config.deadlineMs ?? 15_000;
  }
  selection(): ClinikoFinancialReviewSelection { return this.#selection; }
  async request(input: NativeRequest, external: AbortSignal): Promise<Result<NativeResult, FinancialRecordFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#deadlineMs);
    const signal = AbortSignal.any([external, deadline.signal]), started = performance.now();
    let dispatched = false, responseOwned: Response | undefined, bodyOwned = false;
    const active = () => !signal.aborted && performance.now() - started <= this.#deadlineMs;
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const value = await awaitUntilAbort(task, signal);
      if (value === undefined || !active()) throw new RecordFailure("unavailable");
      return value;
    };
    const permit = async () => {
      if (await wait(Promise.resolve().then(() => this.#authority.allows(input.query, signal))) !== true) throw new RecordFailure("forbidden");
      if (input.method === "POST" && await wait(Promise.resolve().then(() => this.#authority.producerAdmitted(input.query, signal))) !== true) throw new RecordFailure("forbidden");
    };
    try {
      const beganAt = financialRecordInstant(this.#clock());
      if (!beganAt) throw new RecordFailure("unavailable");
      if (input.method === "POST" && input.notAfter !== undefined && beganAt >= input.notAfter) throw new RecordFailure("forbidden");
      if (input.method === "POST" && input.notBefore !== undefined && beganAt < input.notBefore) throw new RecordFailure("forbidden");
      await permit();
      if (input.method === "POST") {
        const claim = await wait(this.#claim(input.query.actionRef));
        if (!claim.ok) throw new RecordFailure("unavailable");
        if (!claim.value.claimed) throw new RecordFailure("alreadyClaimed");
      }
      const limited = await wait(claimClinikoBudget(this.#budget)); if (limited) return err(limited);
      await permit();
      const now = financialRecordInstant(this.#clock());
      if (!now || now < beganAt || !active()) throw new RecordFailure("unavailable");
      if (input.method === "POST" && input.notAfter !== undefined && now >= input.notAfter) throw new RecordFailure("forbidden");
      const url = `${this.#base}/recalls${input.method === "GET" ? `/${input.recallId}` : ""}`;
      const init: RequestInit = { method: input.method, redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: this.#authorization, "Content-Type": "application/json", "User-Agent": this.#agent },
        ...(input.method === "POST" ? { body: JSON.stringify({ patient_id: input.query.patientId, recall_type_id: this.#selection.recallTypeId,
          recall_at: input.recallAt, notes: input.notes, recalled: false }) } : {}) };
      if (!active() || this.#authority.current(input.query, signal) !== true) throw new RecordFailure("forbidden");
      dispatched = input.method === "POST";
      const response = await wait(this.#fetch(url, init).then(value => {
        responseOwned = value; if (signal.aborted) discard(value); return value;
      }));
      if (response.status === 429) {
        const limited = await wait(observeCliniko429(this.#budget, response.headers.get("X-RateLimit-Reset")));
        return dispatched ? ok({ kind: "uncertain" }) : err(limited);
      }
      if (response.status !== (input.method === "POST" ? 201 : 200)) {
        if (dispatched) return ok({ kind: "uncertain" });
        return err({ kind: response.status === 401 || response.status === 403 ? "forbidden" : "unavailable" });
      }
      bodyOwned = true;
      const bytes = await ownedBodyBytes(response.body, 1_000_000, signal);
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { throw new RecordFailure("malformed"); }
      const row = object(raw), createdAt = financialRecordInstant(row?.created_at), updatedAt = financialRecordInstant(row?.updated_at);
      const archivedAt = row?.archived_at === null ? null : financialRecordInstant(row?.archived_at);
      if (!row || typeof row.id !== "string" || !/^[1-9][0-9]{0,18}$/.test(row.id) ||
          link(row) !== `${this.#base}/recalls/${row.id}` || link(row.patient) !== `${this.#base}/patients/${input.query.patientId}` ||
          link(row.recall_type) !== `${this.#base}/recall_types/${this.#selection.recallTypeId}` ||
          typeof row.notes !== "string" || row.notes.length > 1_050 || !row.notes.startsWith(`Abby request ${input.query.actionRef}\n`) ||
          !validRecallDate(row.recall_at) || typeof row.recalled !== "boolean" || !createdAt || !updatedAt || createdAt > updatedAt ||
          archivedAt === undefined || archivedAt !== null && archivedAt < createdAt ||
          input.method === "GET" && row.id !== input.recallId ||
          input.method === "POST" && (row.notes !== input.notes || row.recall_at !== input.recallAt || row.recalled || archivedAt !== null ||
            input.query.intentRecallRef === `cliniko:recall:${row.id}`)) {
        throw new RecordFailure("mismatched");
      }
      if (input.method === "GET") await permit();
      const observedAt = financialRecordInstant(this.#clock());
      if (!observedAt || observedAt < beganAt || Date.parse(updatedAt) > Date.parse(observedAt) + 30_000 || !active() ||
          input.method === "GET" && this.#authority.current(input.query, signal) !== true) throw new RecordFailure("unavailable");
      return ok({ kind: "record", recallRef: `cliniko:recall:${row.id}`, notes: row.notes, recallAt: row.recall_at,
        createdAt, updatedAt, recalled: row.recalled, archivedAt });
    } catch (error) {
      return dispatched ? ok({ kind: "uncertain" }) : err({ kind: error instanceof RecordFailure ? error.kind : "unavailable" });
    } finally {
      clearTimeout(timer); deadline.abort(); if (!bodyOwned) discard(responseOwned);
    }
  }
}
