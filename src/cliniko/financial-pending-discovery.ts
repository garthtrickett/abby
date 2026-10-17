import { KeyObject } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError, ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { validRecallDate } from "./recall-note.ts";
import { financialRecordOwnerBinding } from "./financial-record-retention.ts";
import type { FinancialRecordRetentionConfig } from "./financial-record-retention.ts";
import { ClinikoFinancialReviewReader } from "./financial-review-read.ts";
import type { ClinikoFinancialReviewFailure, ClinikoFinancialReviewSelection } from "./financial-review-read.ts";
import type { FinancialDiscoveredWork, FinancialDiscoveredAttempt, FinancialDiscoveredMessageAttempt, FinancialDiscoveredExpiryAttempt, FinancialDiscoveredResendRequest, FinancialDiscoveryRecordQuery } from "./financial-work-discovery.ts";
import { financialConfigShard, financialSelection, financialRecordInstant as instant } from "./internal/financial-record-context.ts";
import { assembleFinancialRecords, FinancialDiscoveryError as ScanFailure } from "./internal/financial-discovery-records.ts";
import type { FinancialListedRecord } from "./internal/financial-discovery-records.ts";

export type FinancialPendingAccountQuery = ClinikoFinancialReviewSelection & Readonly<{
  purpose: "pendingUnrecalledFinancialWork"; includeArchived: false; unrecalledAtOnly: true;
}>;
/** A separate account-wide grant, never inferred from window/patient discovery,
 * producer trust, a webhook signature or collection permission. Cliniko has no
 * documented recall-type/notes list filter, so unrelated pending rows are read
 * under this grant and discarded at the private adapter boundary. */
export type FinancialPendingAuthority = Readonly<{
  allowsPendingRead(query: FinancialPendingAccountQuery, signal: AbortSignal): Promise<boolean>;
  allowsRecordRead(query: FinancialDiscoveryRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialPendingAccountQuery | FinancialDiscoveryRecordQuery, signal: AbortSignal): boolean;
}>;
export type FinancialPendingResult = Readonly<{
  kind: "pendingContext"; scanned: number; observedAt: string;
  work: readonly FinancialDiscoveredWork[]; attempts: readonly FinancialDiscoveredAttempt[];
  messageAttempts?: readonly FinancialDiscoveredMessageAttempt[];
  expiryAttempts?: readonly FinancialDiscoveredExpiryAttempt[];
  resendRequests?: readonly FinancialDiscoveredResendRequest[];
}>;
type Failure = ClinikoFinancialReviewFailure;
type Row = Record<string, unknown>;
const object = (v: unknown): Row | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* Owned cleanup only. */ } }

/** Bounded pending observation, not global queue completion, absence proof or
 * durable webhook ACK. Native records remain provider-owned; this creates no
 * local queue and performs no write. Oversized/changed/unknown scans refuse. */
export class ClinikoFinancialPendingDiscovery {
  readonly #config: FinancialRecordRetentionConfig;
  readonly #selection: ClinikoFinancialReviewSelection;
  readonly #authority: FinancialPendingAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  private constructor(config: FinancialRecordRetentionConfig, authority: FinancialPendingAuthority, port: typeof fetch, shard: string) {
    this.#selection = financialSelection(config);
    this.#config = Object.freeze({ ...config, scope: this.#selection.scope, stripe: this.#selection.stripe, producer: Object.freeze({ ...config.producer }) });
    this.#authority = Object.freeze({ allowsPendingRead: authority.allowsPendingRead.bind(authority), allowsRecordRead: authority.allowsRecordRead.bind(authority),
      current: authority.current.bind(authority) });
    this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
  }
  static create(config: FinancialRecordRetentionConfig, authority: FinancialPendingAuthority, port: typeof fetch = fetch): Result<ClinikoFinancialPendingDiscovery, Failure> {
    try {
      const shard = financialConfigShard(config, port);
      if (!shard || !financialRecordOwnerBinding(config).ok || !(config.producer.publicKey instanceof KeyObject) ||
          typeof authority?.allowsPendingRead !== "function" || typeof authority.allowsRecordRead !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      return ok(new ClinikoFinancialPendingDiscovery(config, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async scanPending(external: AbortSignal): Promise<Result<FinancialPendingResult, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), ms = this.#config.deadlineMs ?? 15_000, timer = setTimeout(() => deadline.abort(), ms);
    const signal = AbortSignal.any([external, deadline.signal]), began = performance.now();
    const account: FinancialPendingAccountQuery = Object.freeze({ ...this.#selection,
      purpose: "pendingUnrecalledFinancialWork", includeArchived: false, unrecalledAtOnly: true });
    const grants = new Map<string, FinancialDiscoveryRecordQuery>();
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const result = await awaitUntilAbort(task, signal);
      if (result === undefined || signal.aborted || performance.now() - began > ms) throw new ScanFailure("unavailable");
      return result;
    };
    const current = (q: FinancialPendingAccountQuery | FinancialDiscoveryRecordQuery) => {
      if (signal.aborted || this.#authority.current(q, signal) !== true) throw new ScanFailure("forbidden");
    };
    const accountPermit = async () => {
      if (await wait(Promise.resolve().then(() => this.#authority.allowsPendingRead(account, signal))) !== true) throw new ScanFailure("forbidden"); current(account);
    };
    const recordPermit = async (q: FinancialDiscoveryRecordQuery) => {
      if (await wait(Promise.resolve().then(() => this.#authority.allowsRecordRead(q, signal))) !== true) throw new ScanFailure("forbidden");
      current(account); current(q); grants.set(`${q.purpose}:${q.recallRef}`, q);
    };
    try {
      const beganAt = instant(this.#config.clock?.() ?? new Date().toISOString()); if (!beganAt) throw new ScanFailure("unavailable");
      let total: number | undefined, scanned = 0, previous = 0n;
      const selected: FinancialListedRecord[] = [];
      for (let page = 1; page <= 5; page++) {
        await accountPermit(); const limited = await wait(claimClinikoBudget(this.#config.rateBudget)); if (limited) return err(limited); await accountPermit();
        const query = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
        // Documented DateTime null operators; no invented notes/type filter.
        query.append("q[]", "recalled_at:!?"); query.append("q[]", "archived_at:!?");
        let response: Response | undefined, bodyOwned = false, body: unknown;
        try {
          current(account);
          const received = await wait(this.#fetch(`${this.#base}/recalls?${query}`, { method: "GET", redirect: "error", signal,
            headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`,
              "User-Agent": `Abby (${this.#config.contactEmail})` } }).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
          if (received.status === 429) return err(await wait(observeCliniko429(this.#config.rateBudget, received.headers.get("X-RateLimit-Reset"))));
          if (received.status === 401 || received.status === 403) throw new ScanFailure("forbidden");
          if (received.status !== 200) throw new ScanFailure("unavailable");
          bodyOwned = true;
          const bytes = await wait(ownedBodyBytes(received.body, 1_000_000, signal));
          try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ScanFailure("malformed"); }
        } finally { if (!bodyOwned) discard(response); }
        await accountPermit();
        const envelope = object(body), count = envelope?.total_entries, rows = envelope?.recalls;
        if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 500 || !Array.isArray(rows) || total !== undefined && total !== count) throw new ScanFailure("malformed");
        total = count as number; if (rows.length !== Math.min(100, total - scanned)) throw new ScanFailure("malformed");
        for (const value of rows) {
          const row = object(value), ref = row?.id, created = instant(row?.created_at), updated = instant(row?.updated_at);
          const patientLink = object(object(row?.patient)?.links)?.self, typeLink = object(object(row?.recall_type)?.links)?.self;
          const patient = typeof patientLink === "string" && patientLink.startsWith(`${this.#base}/patients/`) ? patientLink.slice(`${this.#base}/patients/`.length) : undefined;
          const type = typeof typeLink === "string" && typeLink.startsWith(`${this.#base}/recall_types/`) ? typeLink.slice(`${this.#base}/recall_types/`.length) : undefined;
          if (!row || !id(ref) || BigInt(ref) <= previous || object(row.links)?.self !== `${this.#base}/recalls/${ref}` || !id(patient) || !id(type) ||
              !created || !updated || created > updated || Date.parse(updated) > Date.parse(beganAt) + 30_000 || row.archived_at !== null ||
              row.recalled_at !== null || row.recalled !== false || !validRecallDate(row.recall_at)) throw new ScanFailure("malformed");
          previous = BigInt(ref); scanned++;
          if (type !== this.#selection.recallTypeId) continue;
          if (typeof row.notes !== "string" || row.notes.length > 1_050 || selected.length >= 50) throw new ScanFailure("malformed");
          selected.push({ recallRef: `cliniko:recall:${ref}`, patientId: patient, notes: row.notes, recalled: false, archivedAt: null });
        }
        if (scanned === total) break;
        if (page === 5) throw new ScanFailure("malformed");
      }
      const queryFor = (recallRef: string, actionRef: string, purpose: FinancialDiscoveryRecordQuery["purpose"]): FinancialDiscoveryRecordQuery =>
        Object.freeze({ ...this.#selection, recallRef, actionRef, purpose, includeArchived: true });
      let lookups = 0;
      const readIntent = async (recallRef: string, actionRef: string, purpose: FinancialDiscoveryRecordQuery["purpose"]) => {
        if (++lookups > 50) throw new ScanFailure("unavailable");
        const reader = ClinikoFinancialReviewReader.create(this.#config, { allows: async q => {
          try { await accountPermit(); await recordPermit(queryFor(q.recallRef, q.actionRef, purpose)); return true; }
          catch (error) { if (error instanceof ScanFailure && error.kind === "forbidden") return false; throw error; }
        } }, this.#fetch);
        if (!reader.ok) throw new ScanFailure("invalidConfig");
        const found = await wait(reader.value.read({ recallRef, actionRef }, signal, { includeArchived: true }));
        if (!found.ok) throw new ScanFailure(found.error.kind); return found.value;
      };
      const { work, attempts, messageAttempts, expiryAttempts, resendRequests } = await assembleFinancialRecords(selected, { beganAt, readIntent,
        trust: { producerKeyRef: this.#config.producer.keyRef, publicKey: this.#config.producer.publicKey },
        permitRecord: (recallRef, actionRef) => recordPermit(queryFor(recallRef, actionRef, "listedFinancialRecord")) });
      await accountPermit(); for (const q of grants.values()) await recordPermit(q);
      current(account); for (const q of grants.values()) current(q);
      const observedAt = instant(this.#config.clock?.() ?? new Date().toISOString());
      if (!observedAt || observedAt < beganAt || signal.aborted || performance.now() - began > ms) throw new ScanFailure("unavailable");
      return ok({ kind: "pendingContext", scanned, observedAt, work, attempts, ...(messageAttempts ? { messageAttempts } : {}), ...(expiryAttempts ? { expiryAttempts } : {}), ...(resendRequests ? { resendRequests } : {}) });
    } catch (error) { return err({ kind: error instanceof ScanFailure || error instanceof OwnedBodyError ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); deadline.abort(); }
  }
}
