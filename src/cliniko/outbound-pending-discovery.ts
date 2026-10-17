import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError, ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { validRecallDate } from "./recall-note.ts";
import { decodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "./outbound-recipient-request.ts";
import { ClinikoOutboundRecipientRecords } from "./outbound-recipient-records.ts";
import type { OutboundRecordConfig, OutboundRecordSelection, OutboundRecordQuery, OutboundRecordFailure, OutboundRecipientRecord } from "./outbound-recipient-records.ts";
import { outboundConfigShard, outboundRecordSelection, outboundRecordOwnerBinding, outboundNativeId, outboundNativeInstant } from "./internal/outbound-record-context.ts";

export type OutboundPendingAccountQuery = OutboundRecordSelection & Readonly<{
  ownerBinding: string; operation: "readPendingRecipientRequests"; includeArchived: false; unrecalledAtOnly: true;
}>;
/** Account-wide collection visibility is independent of exact private-record
 * access. No producer, effect journal, audience/DNC or contact grant is implied. */
export type OutboundPendingAuthority = Readonly<{
  allowsPendingRead(query: OutboundPendingAccountQuery, signal: AbortSignal): Promise<boolean>;
  allowsRecordRead(query: OutboundRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundPendingAccountQuery | OutboundRecordQuery, signal: AbortSignal): boolean;
}>;
export type OutboundPendingResult = Readonly<{
  kind: "pendingRecipientContext"; scanned: number; observedAt: string; records: readonly OutboundRecipientRecord[];
}>;
type FailureKind = OutboundRecordFailure["kind"];
type Row = Record<string, unknown>;
const object = (v: unknown): Row | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const self = (v: unknown) => object(object(v)?.links)?.self;
class Failure extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind) { super("Pending outbound context unavailable"); this.kind = kind; }
}
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* Owned body only. */ } }
type Listed = Readonly<{ id: string; patientId: string; notes: string; recallAt: string; createdAt: string; updatedAt: string }>;

/** Bounded read-only observation, not a queue, completion or absence proof.
 * Limits:500 account rows,50 selected requests; every physical GET shares the
 * supplied account budget. Unknown/changed/over-bound observations refuse. */
export class ClinikoOutboundPendingDiscovery {
  readonly #config: OutboundRecordConfig;
  readonly #account: OutboundPendingAccountQuery;
  readonly #authority: OutboundPendingAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  private constructor(config: OutboundRecordConfig, authority: OutboundPendingAuthority, port: typeof fetch, shard: string, owner: string) {
    this.#account = Object.freeze({ ...outboundRecordSelection(config), ownerBinding: owner,
      operation: "readPendingRecipientRequests", includeArchived: false, unrecalledAtOnly: true });
    this.#config = Object.freeze({ ...config, scope: this.#account.scope,
      rateBudget: Object.freeze({ claim: config.rateBudget.claim.bind(config.rateBudget), observe429: config.rateBudget.observe429.bind(config.rateBudget) }),
      ...(config.clock ? { clock: config.clock.bind(config) } : {}) });
    this.#authority = Object.freeze({ allowsPendingRead: authority.allowsPendingRead.bind(authority),
      allowsRecordRead: authority.allowsRecordRead.bind(authority), current: authority.current.bind(authority) });
    this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
  }
  static create(config: OutboundRecordConfig, authority: OutboundPendingAuthority, port: typeof fetch = fetch): Result<ClinikoOutboundPendingDiscovery, OutboundRecordFailure> {
    try {
      const shard = outboundConfigShard(config, port), owner = outboundRecordOwnerBinding(config);
      if (!shard || !owner || [authority?.allowsPendingRead, authority?.allowsRecordRead, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundPendingDiscovery(config, authority, port, shard, owner));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async scanPending(external: AbortSignal): Promise<Result<OutboundPendingResult, OutboundRecordFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), ms = this.#config.deadlineMs ?? 15000, timer = setTimeout(() => deadline.abort(), ms);
    const signal = AbortSignal.any([external, deadline.signal]), began = performance.now(), account = this.#account;
    const grants = new Map<string, OutboundRecordQuery>(); let lastAt: string | undefined;
    const active = () => !signal.aborted && performance.now()-began <= ms;
    const clock = () => {
      const raw = this.#config.clock?.() ?? new Date().toISOString(), at = outboundNativeInstant(raw);
      if (!at || at !== raw || lastAt !== undefined && at < lastAt || !active()) throw new Failure("unavailable");
      lastAt = at; return at;
    };
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const value = await awaitUntilAbort(task, signal); if (value === undefined || !active()) throw new Failure("unavailable"); clock(); return value;
    };
    const current = (q: OutboundPendingAccountQuery | OutboundRecordQuery) => {
      if (!active() || this.#authority.current(q, signal) !== true || !active()) throw new Failure("forbidden");
    };
    const accountPermit = async () => {
      current(account);
      if (await wait(Promise.resolve().then(() => this.#authority.allowsPendingRead(account, signal))) !== true) throw new Failure("forbidden");
      current(account);
    };
    const recordPermit = async (q: OutboundRecordQuery) => {
      current(account); current(q);
      if (await wait(Promise.resolve().then(() => this.#authority.allowsRecordRead(q, signal))) !== true) throw new Failure("forbidden");
      current(account); current(q); grants.set(q.recallRef!, q);
    };
    try {
      clock(); let total: number | undefined, scanned = 0, previous = 0n;
      const selected: Listed[] = [];
      for (let page = 1; page <= 5; page++) {
        await accountPermit(); const limited = await wait(claimClinikoBudget(this.#config.rateBudget)); if (limited) return err(limited); await accountPermit();
        const query = new URLSearchParams({ page: String(page), per_page: "100", sort: "id:asc" });
        // Only documented null DateTime filters; no notes/type filter exists.
        query.append("q[]", "recalled_at:!?"); query.append("q[]", "archived_at:!?");
        let response: Response | undefined, bodyOwned = false, raw: unknown;
        try {
          current(account); clock();
          const found = await wait(this.#fetch(`${this.#base}/recalls?${query}`, { method: "GET", redirect: "error", signal,
            headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`,
              "User-Agent": `Abby (${this.#config.contactEmail})` } }).then(r => { response = r; if (signal.aborted) discard(r); return r; }));
          if (found.status === 429) return err(await wait(observeCliniko429(this.#config.rateBudget, found.headers.get("X-RateLimit-Reset"))));
          if (found.status === 401 || found.status === 403) throw new Failure("forbidden");
          if (found.status !== 200) throw new Failure("unavailable");
          bodyOwned = true; const bytes = await wait(ownedBodyBytes(found.body, 1_000_000, signal));
          try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Failure("malformed"); }
        } finally { if (!bodyOwned) discard(response); }
        await accountPermit();
        const envelope = object(raw), count = envelope?.total_entries, rows = envelope?.recalls;
        if (!Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 500 || !Array.isArray(rows) || total !== undefined && count !== total) throw new Failure("malformed");
        total = count as number; if (rows.length !== Math.min(100,total-scanned)) throw new Failure("malformed");
        const observedAt = clock();
        for (const value of rows) {
          const row = object(value), id = row?.id, createdAt = outboundNativeInstant(row?.created_at), updatedAt = outboundNativeInstant(row?.updated_at);
          const patientLink = self(row?.patient), typeLink = self(row?.recall_type);
          const patientId = typeof patientLink === "string" && patientLink.startsWith(`${this.#base}/patients/`) ? patientLink.slice(`${this.#base}/patients/`.length) : undefined;
          const typeId = typeof typeLink === "string" && typeLink.startsWith(`${this.#base}/recall_types/`) ? typeLink.slice(`${this.#base}/recall_types/`.length) : undefined;
          if (!row || !outboundNativeId(id) || BigInt(id) <= previous || self(row) !== `${this.#base}/recalls/${id}` || !outboundNativeId(patientId) || !outboundNativeId(typeId) ||
              !createdAt || !updatedAt || createdAt > updatedAt || Date.parse(updatedAt) > Date.parse(observedAt)+30000 ||
              row.archived_at !== null || row.recalled_at !== null || row.recalled !== false || !validRecallDate(row.recall_at)) throw new Failure("malformed");
          previous = BigInt(id); scanned++;
          if (typeId !== account.outboundRecallTypeId) continue;
          if (typeof row.notes !== "string" || row.notes.length > 1050 || selected.length >= 50) throw new Failure("malformed");
          selected.push({ id, patientId, notes: row.notes, recallAt: row.recall_at, createdAt, updatedAt });
        }
        if (scanned === total) break;
        if (page === 5) throw new Failure("malformed");
      }
      const ids = new Set<string>(), records: OutboundRecipientRecord[] = [];
      const reader = ClinikoOutboundRecipientRecords.createReadOnly(this.#config, {
        allows: async q => { await accountPermit(); await recordPermit(q); return true; },
        current: q => { try { current(account); current(q); return true; } catch { return false; } },
      }, this.#fetch);
      if (!reader.ok) return reader;
      for (const listed of selected) {
        const parsed = decodeOutboundRecipientRequest(listed.notes); if (!parsed.ok) throw new Failure("malformed");
        const request = parsed.value;
        for (const ref of [request.actionRef,request.approvalRef,request.effectRef]) {
          if (ids.has(ref)) throw new Failure("mismatched"); ids.add(ref);
        }
        const found = await wait(reader.value.readRequest({ recallRef: `cliniko:recall:${listed.id}`, actionRef: request.actionRef, patientId: listed.patientId }, signal));
        if (!found.ok) return found;
        const record = found.value;
        if (record.recalled !== false || record.recalledAt !== null || record.archivedAt !== null ||
            record.recallAt !== listed.recallAt || record.createdAt !== listed.createdAt || record.updatedAt !== listed.updatedAt ||
            outboundRecipientRequestDigest(record.request) !== outboundRecipientRequestDigest(request)) throw new Failure("mismatched");
        records.push(record);
      }
      await accountPermit(); for (const q of grants.values()) await recordPermit(q);
      current(account); for (const q of grants.values()) current(q);
      return ok(Object.freeze({ kind: "pendingRecipientContext", scanned, observedAt: clock(), records: Object.freeze(records) }));
    } catch (error) { return err({ kind: error instanceof Failure || error instanceof OwnedBodyError ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); deadline.abort(); }
  }
}
