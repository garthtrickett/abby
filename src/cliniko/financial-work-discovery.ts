import { KeyObject } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError, ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { authenticateFinancialBookingCitation, verifyFinancialBookingObservation } from "./financial-booking-observation.ts";
import type { ClinikoFinancialBookingObservation } from "./financial-booking-observation.ts";
import { financialRecordOwnerBinding } from "./financial-record-retention.ts";
import type { FinancialRecordRetentionConfig } from "./financial-record-retention.ts";
import { ClinikoFinancialReviewReader } from "./financial-review-read.ts";
import type { ClinikoFinancialReviewContext, ClinikoFinancialReviewFailure, ClinikoFinancialReviewSelection } from "./financial-review-read.ts";
import { decodeClinikoFinancialIntent } from "./financial-review-intent.ts";
import { financialConfigShard, financialSelection, financialRecordInstant as instant } from "./internal/financial-record-context.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { validRecallDate } from "./recall-note.ts";

export type FinancialDiscoveryWindow = Readonly<{ createdFrom: string; createdThrough: string }>;
export type FinancialDiscoveryAccountQuery = ClinikoFinancialReviewSelection & FinancialDiscoveryWindow & Readonly<{ includeArchived: true }>;
export type FinancialDiscoveryRecordQuery = ClinikoFinancialReviewSelection & Readonly<{
  recallRef: string; actionRef: string; includeArchived: true; purpose: "listedFinancialRecord" | "sourceIntent";
}>;
/** Account-wide reading is an explicit trusted grant: Cliniko recalls have no
 * native business/location field or documented recall-type list filter. Notes
 * and signatures cannot supply this grant. Both grants must remain current. */
export type FinancialDiscoveryAuthority = Readonly<{
  allowsAccountRead(query: FinancialDiscoveryAccountQuery, signal: AbortSignal): Promise<boolean>;
  allowsRecordRead(query: FinancialDiscoveryRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialDiscoveryAccountQuery | FinancialDiscoveryRecordQuery, signal: AbortSignal): boolean;
}>;
export type FinancialDiscoveredWork = Readonly<
  { kind: "intentContext"; intent: ClinikoFinancialReviewContext } |
  { kind: "pairedContext"; intent: ClinikoFinancialReviewContext; observation: ClinikoFinancialBookingObservation;
    observationRecallRef: string; recalled: boolean; archivedAt: string | null }
>;
/** A bounded scan observation, not an atomic snapshot, global queue completion,
 * absence proof, immutable history, booking/effect admission or payment truth.
 * Private contexts must be reread and independently authorized before effects. */
export type FinancialDiscoveryResult = Readonly<{
  kind: "windowContext"; window: FinancialDiscoveryWindow; scanned: number; observedAt: string;
  work: readonly FinancialDiscoveredWork[];
}>;
type Failure = ClinikoFinancialReviewFailure;
type Row = Record<string, unknown>;
function row(v: unknown): Row | undefined { return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined; }
const nativeId = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
class ScanFailure extends Error {
  constructor(readonly kind: Failure["kind"]) { super("Financial discovery unavailable"); }
}
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* No private diagnostics. */ } }
type Listed = { recallRef: string; patientId: string; notes: string; recalled: boolean; archivedAt: string | null };

/** Read-only, count-driven bounded discovery. No writes, arbitrary link following,
 * local queue, implicit account budget, latest-row choice or partial success. */
export class ClinikoFinancialWorkDiscovery {
  readonly #config: FinancialRecordRetentionConfig;
  readonly #selection: ClinikoFinancialReviewSelection;
  readonly #authority: FinancialDiscoveryAuthority;
  readonly #port: typeof fetch;
  readonly #base: string;
  private constructor(config: FinancialRecordRetentionConfig, authority: FinancialDiscoveryAuthority, port: typeof fetch, shard: string) {
    this.#selection = financialSelection(config);
    this.#config = Object.freeze({ ...config, scope: this.#selection.scope, stripe: this.#selection.stripe,
      producer: Object.freeze({ ...config.producer }) });
    this.#authority = Object.freeze({ allowsAccountRead: authority.allowsAccountRead.bind(authority),
      allowsRecordRead: authority.allowsRecordRead.bind(authority), current: authority.current.bind(authority) });
    this.#port = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
  }
  static create(config: FinancialRecordRetentionConfig, authority: FinancialDiscoveryAuthority, port: typeof fetch = fetch): Result<ClinikoFinancialWorkDiscovery, Failure> {
    try {
      const shard = financialConfigShard(config, port);
      if (!shard || !financialRecordOwnerBinding(config).ok || !(config.producer.publicKey instanceof KeyObject) ||
          typeof authority?.allowsAccountRead !== "function" || typeof authority.allowsRecordRead !== "function" ||
          typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      return ok(new ClinikoFinancialWorkDiscovery(config, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async scan(input: FinancialDiscoveryWindow, external: AbortSignal): Promise<Result<FinancialDiscoveryResult, Failure>> {
    const from = instant(input?.createdFrom), through = instant(input?.createdThrough);
    if (!from || !through || from !== input.createdFrom || through !== input.createdThrough || from > through ||
        Date.parse(through) - Date.parse(from) > 3_600_000) return err({ kind: "invalidQuery" });
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const window = Object.freeze({ createdFrom: from, createdThrough: through });
    const account = Object.freeze({ ...this.#selection, ...window, includeArchived: true as const });
    const deadline = new AbortController(), ms = this.#config.deadlineMs ?? 15_000;
    const timer = setTimeout(() => deadline.abort(), ms), signal = AbortSignal.any([external, deadline.signal]), began = performance.now();
    const grants = new Map<string, FinancialDiscoveryRecordQuery>();
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const result = await awaitUntilAbort(task, signal);
      if (result === undefined || signal.aborted || performance.now() - began > ms) throw new ScanFailure("unavailable");
      return result;
    };
    const current = (query: FinancialDiscoveryAccountQuery | FinancialDiscoveryRecordQuery) => {
      if (signal.aborted || this.#authority.current(query, signal) !== true) throw new ScanFailure("forbidden");
    };
    const accountPermit = async () => { if (await wait(Promise.resolve().then(() => this.#authority.allowsAccountRead(account, signal))) !== true) throw new ScanFailure("forbidden"); current(account); };
    const recordPermit = async (q: FinancialDiscoveryRecordQuery) => {
      if (await wait(Promise.resolve().then(() => this.#authority.allowsRecordRead(q, signal))) !== true) throw new ScanFailure("forbidden");
      current(account); current(q); grants.set(`${q.purpose}:${q.recallRef}`, q);
    };
    try {
      const beganAt = instant(this.#config.clock?.() ?? new Date().toISOString());
      if (!beganAt || Date.parse(through) > Date.parse(beganAt) + 30_000) throw new ScanFailure("invalidQuery");
      let total: number | undefined, scanned = 0, previous = 0n;
      const selected: Listed[] = [];
      for (let page = 1; ; page++) {
        await accountPermit();
        const limited = await wait(claimClinikoBudget(this.#config.rateBudget)); if (limited) return err(limited);
        await accountPermit();
        const query = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
        query.append("q[]", `created_at:>=${from}`); query.append("q[]", `created_at:<=${through}`); query.append("q[]", "archived_at:*");
        let response: Response | undefined, bodyOwned = false;
        let body: unknown;
        try {
          current(account);
          response = await wait(this.#port(`${this.#base}/recalls?${query}`, { method: "GET", redirect: "error", signal,
            headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`,
              "User-Agent": `Abby (${this.#config.contactEmail})` } }).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
          if (response.status === 429) return err(await wait(observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset"))));
          if (response.status === 401 || response.status === 403) throw new ScanFailure("forbidden");
          if (response.status !== 200) throw new ScanFailure("unavailable");
          bodyOwned = true;
          const bytes = await ownedBodyBytes(response.body, 1_000_000, signal);
          try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new ScanFailure("malformed"); }
        } finally { if (!bodyOwned) discard(response); }
        await accountPermit();
        const envelope = row(body), count = envelope?.total_entries, rows = envelope?.recalls;
        if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 500 || !Array.isArray(rows) ||
            total !== undefined && count !== total) throw new ScanFailure("malformed");
        total = count as number;
        if (rows.length !== Math.min(100, total - scanned)) throw new ScanFailure("malformed");
        for (const value of rows) {
          const r = row(value), id = r?.id, created = instant(r?.created_at), updated = instant(r?.updated_at);
          const archived = r?.archived_at === null ? null : instant(r?.archived_at);
          const patientLink = row(row(r?.patient)?.links)?.self, typeLink = row(row(r?.recall_type)?.links)?.self;
          const patient = typeof patientLink === "string" && patientLink.startsWith(`${this.#base}/patients/`) ? patientLink.slice(`${this.#base}/patients/`.length) : undefined;
          const type = typeof typeLink === "string" && typeLink.startsWith(`${this.#base}/recall_types/`) ? typeLink.slice(`${this.#base}/recall_types/`.length) : undefined;
          if (!r || !nativeId(id) || BigInt(id) <= previous || row(r.links)?.self !== `${this.#base}/recalls/${id}` ||
              !nativeId(patient) || !nativeId(type) || !created || created < from || created > through || !updated || created > updated ||
              archived === undefined || archived !== null && (archived < created || Date.parse(archived) > Date.parse(beganAt) + 30_000) ||
              Date.parse(updated) > Date.parse(beganAt) + 30_000 || typeof r.recalled !== "boolean" || !validRecallDate(r.recall_at)) throw new ScanFailure("malformed");
          previous = BigInt(id); scanned++;
          if (type !== this.#selection.recallTypeId) continue;
          if (typeof r.notes !== "string" || r.notes.length > 1_050 || selected.length >= 50) throw new ScanFailure("malformed");
          selected.push({ recallRef: `cliniko:recall:${id}`, patientId: patient, notes: r.notes, recalled: r.recalled, archivedAt: archived });
        }
        if (scanned === total) break;
        if (page >= 5) throw new ScanFailure("malformed");
      }
      const intents = new Map<string, ClinikoFinancialReviewContext>(), actions = new Set<string>();
      const observations: { native: Listed; proof: ClinikoFinancialBookingObservation }[] = [];
      const trust = { producerKeyRef: this.#config.producer.keyRef, publicKey: this.#config.producer.publicKey };
      const queryFor = (recallRef: string, actionRef: string, purpose: FinancialDiscoveryRecordQuery["purpose"]): FinancialDiscoveryRecordQuery =>
        Object.freeze({ ...this.#selection, recallRef, actionRef, purpose, includeArchived: true });
      let lookups = 0;
      const readIntent = async (recallRef: string, actionRef: string, purpose: FinancialDiscoveryRecordQuery["purpose"]) => {
        if (++lookups > 50) throw new ScanFailure("unavailable");
        const reader = ClinikoFinancialReviewReader.create(this.#config, { allows: async q => {
          await accountPermit(); await recordPermit(queryFor(q.recallRef, q.actionRef, purpose)); return true;
        } }, this.#port);
        if (!reader.ok) throw new ScanFailure("invalidConfig");
        const result = await wait(reader.value.read({ recallRef, actionRef }, signal, { includeArchived: true }));
        if (!result.ok) throw new ScanFailure(result.error.kind);
        return result.value;
      };
      for (const native of selected) {
        const decoded = decodeClinikoFinancialIntent(native.notes);
        const citation = decoded.ok ? undefined : authenticateFinancialBookingCitation(native.notes, trust);
        const actionRef = decoded.ok ? decoded.value.actionRef : citation?.ok ? citation.value.actionRef : undefined;
        if (!actionRef || actions.has(actionRef)) throw new ScanFailure("mismatched");
        actions.add(actionRef);
        await recordPermit(queryFor(native.recallRef, actionRef, "listedFinancialRecord"));
        if (decoded.ok) {
          const context = await readIntent(native.recallRef, actionRef, "listedFinancialRecord");
          // Reject record mutation during discovery rather than mix two contexts.
          if (JSON.stringify(context.intent) !== JSON.stringify(decoded.value) || context.intent.patientId !== native.patientId ||
              context.recalled !== native.recalled || context.archivedAt !== native.archivedAt) throw new ScanFailure("mismatched");
          intents.set(native.recallRef, context);
        } else if (citation?.ok) observations.push({ native, proof: citation.value });
        else throw new ScanFailure("malformed");
      }
      const paired = new Set<string>(), targets = new Set<string>(), bookingActions = new Set<string>(), work: FinancialDiscoveredWork[] = [];
      for (const { native, proof } of observations) {
        if (proof.intentRecallRef === native.recallRef || paired.has(proof.intentRecallRef) || targets.has(proof.targetRef) || bookingActions.has(proof.bookingActionRef)) throw new ScanFailure("mismatched");
        const intent = intents.get(proof.intentRecallRef) ?? await readIntent(proof.intentRecallRef, proof.financialActionRef, "sourceIntent");
        const bound = verifyFinancialBookingObservation(native.notes, { intent: intent.intent, intentRecallRef: intent.recallRef, ...trust });
        if (!bound.ok || intent.intent.patientId !== native.patientId || Date.parse(proof.observedAt) > Date.parse(beganAt) + 30_000) throw new ScanFailure("mismatched");
        paired.add(proof.intentRecallRef); targets.add(proof.targetRef); bookingActions.add(proof.bookingActionRef);
        work.push({ kind: "pairedContext", intent, observation: bound.value, observationRecallRef: native.recallRef,
          recalled: native.recalled, archivedAt: native.archivedAt });
      }
      for (const [ref, intent] of intents) if (!paired.has(ref)) work.push({ kind: "intentContext", intent });
      // One-use IDs and clinical markers cannot be shared by separate obligations.
      // A note signature alone cannot make duplicate payment intents unique.
      const obligationIds = new Set<string>();
      for (const item of work) {
        const intent = item.intent.intent;
        for (const id of [intent.actionRef, intent.booking.actionRef, ...Object.values(intent.effects),
          ...(item.kind === "pairedContext" ? [item.observation.actionRef] : [])]) {
          if (obligationIds.has(id)) throw new ScanFailure("mismatched");
          obligationIds.add(id);
        }
      }
      await accountPermit();
      for (const q of grants.values()) await recordPermit(q);
      current(account); for (const q of grants.values()) current(q);
      const observedAt = instant(this.#config.clock?.() ?? new Date().toISOString());
      if (!observedAt || observedAt < beganAt || signal.aborted || performance.now() - began > ms) throw new ScanFailure("unavailable");
      return ok({ kind: "windowContext", window, scanned, observedAt, work });
    } catch (error) { return err({ kind: error instanceof ScanFailure || error instanceof OwnedBodyError ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); deadline.abort(); }
  }
}
