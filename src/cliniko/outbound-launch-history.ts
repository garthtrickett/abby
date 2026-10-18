import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError, ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { validRecallDate } from "./recall-note.ts";
import { decodeOutboundLaunchAttempt, outboundLaunchAttemptDigest, outboundAttemptMatchesRequest } from "./outbound-launch-attempt.ts";
import { ClinikoOutboundLaunchRecords } from "./outbound-launch-records.ts";
import type { OutboundLaunchRecordConfig, OutboundLaunchRecordSelection, OutboundLaunchRecordQuery, OutboundLaunchRecordFailure, OutboundLaunchRecord } from "./outbound-launch-records.ts";
import { outboundNativeId, outboundNativeInstant } from "./internal/outbound-record-context.ts";
import { outboundLaunchConfigShard, outboundLaunchRecordSelection, outboundLaunchRecordOwnerBinding } from "./internal/outbound-launch-record-context.ts";
import { encodeOutboundRecipientRequest, decodeOutboundRecipientRequest } from "./outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "./outbound-recipient-request.ts";

export type OutboundLaunchHistoryQuery = OutboundLaunchRecordSelection & Readonly<{
  ownerBinding: string; operation: "readPossibleLaunchHistory"; patientId: string; includeArchived: true; includeClosed: true;
}>;
/** Exact-patient collection visibility is independent of exact private-record
 * access. No producer, effect journal, audience/DNC or contact grant is implied. */
export type OutboundLaunchHistoryAuthority = Readonly<{
  allowsHistoryRead(query: OutboundLaunchHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsRecordRead(query: OutboundLaunchRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundLaunchHistoryQuery | OutboundLaunchRecordQuery, signal: AbortSignal): boolean;
}>;
export type OutboundLaunchHistoryResult = Readonly<{
  kind: "possibleLaunchHistory"; scanned: number; observedAt: string; records: readonly OutboundLaunchRecord[];
}>;
type FailureKind = OutboundLaunchRecordFailure["kind"];
type Row = Record<string, unknown>;
const object = (v: unknown): Row | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const self = (v: unknown) => object(object(v)?.links)?.self;
class Failure extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind) { super("Outbound possible-launch history unavailable"); this.kind = kind; }
}
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* Owned body only. */ } }
type Listed = Readonly<{ id: string; patientId: string; notes: string; recallAt: string; createdAt: string; updatedAt: string; recalled: boolean; recalledAt: string|null; archivedAt: string|null }>;

/** Complete bounded, archived-inclusive patient evidence, never a launch grant.
 * At most500 patient rows/50 attempt records. Unknown, changed or conflicting
 * evidence refuses. Closure, archival and dispatch-window expiry cannot erase a
 * possible attempt. All physical GETs use the existing account budget. */
export class ClinikoOutboundLaunchHistory {
  readonly #config: OutboundLaunchRecordConfig;
  readonly #selection: OutboundLaunchRecordSelection;
  readonly #owner: string;
  readonly #authority: OutboundLaunchHistoryAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  private constructor(config: OutboundLaunchRecordConfig, authority: OutboundLaunchHistoryAuthority, port: typeof fetch, shard: string, owner: string) {
    this.#selection = outboundLaunchRecordSelection(config); this.#owner = owner;
    this.#config = Object.freeze({ ...config, scope: this.#selection.scope,
      rateBudget: Object.freeze({ claim: config.rateBudget.claim.bind(config.rateBudget), observe429: config.rateBudget.observe429.bind(config.rateBudget) }),
      ...(config.clock ? { clock: config.clock.bind(config) } : {}) });
    this.#authority = Object.freeze({ allowsHistoryRead: authority.allowsHistoryRead.bind(authority),
      allowsRecordRead: authority.allowsRecordRead.bind(authority), current: authority.current.bind(authority) });
    this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
  }
  static create(config: OutboundLaunchRecordConfig, authority: OutboundLaunchHistoryAuthority, port: typeof fetch = fetch): Result<ClinikoOutboundLaunchHistory, OutboundLaunchRecordFailure> {
    try {
      const shard = outboundLaunchConfigShard(config, port), owner = outboundLaunchRecordOwnerBinding(config);
      if (!shard || !owner || [authority?.allowsHistoryRead, authority?.allowsRecordRead, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundLaunchHistory(config, authority, port, shard, owner));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async readForRequest(input: Readonly<{ recallRef: string; request: OutboundRecipientRequest }>, external: AbortSignal): Promise<Result<OutboundLaunchHistoryResult, OutboundLaunchRecordFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    let request: OutboundRecipientRequest, recallRef: string;
    try {
      if (!input || Object.keys(input).sort().join(",") !== "recallRef,request" || !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(input.recallRef)) return err({kind:"invalidQuery"});
      const encoded = encodeOutboundRecipientRequest(input.request); if (!encoded.ok) return err({kind:"invalidQuery"});
      const decoded = decodeOutboundRecipientRequest(encoded.value); if (!decoded.ok) return err({kind:"invalidQuery"});
      request = decoded.value; recallRef = input.recallRef; const s = this.#selection;
      if (request.businessId !== s.businessId || request.credentialFingerprint !== s.credentialFingerprint ||
          request.scope.tenantId !== s.scope.tenantId || request.scope.clinicId !== s.scope.clinicId || request.scope.locationId !== s.scope.locationId) return err({kind:"invalidQuery"});
    } catch { return err({kind:"invalidQuery"}); }
    const account: OutboundLaunchHistoryQuery = Object.freeze({...this.#selection,ownerBinding:this.#owner,operation:"readPossibleLaunchHistory",
      patientId:request.patientId,includeArchived:true,includeClosed:true});
    const deadline = new AbortController(), ms = this.#config.deadlineMs ?? 15000, timer = setTimeout(() => deadline.abort(), ms);
    const signal = AbortSignal.any([external, deadline.signal]), began = performance.now();
    const grants = new Map<string, OutboundLaunchRecordQuery>(); let lastAt: string | undefined;
    const active = () => !signal.aborted && performance.now()-began <= ms;
    const clock = () => {
      const raw = this.#config.clock?.() ?? new Date().toISOString(), at = outboundNativeInstant(raw);
      if (!at || at !== raw || lastAt !== undefined && at < lastAt || !active()) throw new Failure("unavailable");
      lastAt = at; return at;
    };
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const value = await awaitUntilAbort(task, signal); if (value === undefined || !active()) throw new Failure("unavailable"); clock(); return value;
    };
    const current = (q: OutboundLaunchHistoryQuery | OutboundLaunchRecordQuery) => {
      if (!active() || this.#authority.current(q, signal) !== true || !active()) throw new Failure("forbidden");
    };
    const accountPermit = async () => {
      current(account);
      if (await wait(Promise.resolve().then(() => this.#authority.allowsHistoryRead(account, signal))) !== true) throw new Failure("forbidden");
      current(account);
    };
    const recordPermit = async (q: OutboundLaunchRecordQuery) => {
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
        query.append("q[]", `patient_id:=${request.patientId}`); query.append("q[]", "archived_at:*");
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
              patientId !== request.patientId || typeof row.recalled !== "boolean" ||
              row.archived_at !== null && !outboundNativeInstant(row.archived_at) || row.recalled_at !== null && !outboundNativeInstant(row.recalled_at) ||
              row.recalled !== (row.recalled_at !== null) ||
              row.archived_at !== null && Date.parse(String(row.archived_at)) > Date.parse(updatedAt) ||
              row.recalled_at !== null && Date.parse(String(row.recalled_at)) > Date.parse(updatedAt) || !validRecallDate(row.recall_at)) throw new Failure("malformed");
          previous = BigInt(id); scanned++;
          if (typeId !== account.outboundAttemptRecallTypeId) continue;
          if (typeof row.notes !== "string" || row.notes.length > 1050 || selected.length >= 50) throw new Failure("malformed");
          selected.push({ id, patientId, notes: row.notes, recallAt: row.recall_at, createdAt, updatedAt, recalled:row.recalled,
            recalledAt:row.recalled_at === null ? null : outboundNativeInstant(row.recalled_at)!, archivedAt:row.archived_at === null ? null : outboundNativeInstant(row.archived_at)! });
        }
        if (scanned === total) break;
        if (page === 5) throw new Failure("malformed");
      }
      const actions = new Set<string>(), records: OutboundLaunchRecord[] = [];
      const reader = ClinikoOutboundLaunchRecords.createReadOnly(this.#config, {
        allows: async q => {
          try { await accountPermit(); await recordPermit(q); return true; }
          catch (error) { if (error instanceof Failure && error.kind === "forbidden") return false; throw error; }
        },
        current: q => { try { current(account); current(q); return true; } catch { return false; } },
      }, this.#fetch);
      if (!reader.ok) return reader;
      for (const listed of selected) {
        const parsed = decodeOutboundLaunchAttempt(listed.notes); if (!parsed.ok) throw new Failure("malformed");
        const attempt = parsed.value;
        if (actions.has(attempt.actionRef)) throw new Failure("mismatched"); actions.add(attempt.actionRef);
        const found = await wait(reader.value.readPossibleAttempt({ recallRef:`cliniko:recall:${listed.id}`, actionRef:attempt.actionRef, patientId:listed.patientId }, signal));
        if (!found.ok) return found;
        const record = found.value;
        if (record.recalled !== listed.recalled || record.recalledAt !== listed.recalledAt || record.archivedAt !== listed.archivedAt ||
            record.recallAt !== listed.recallAt || record.createdAt !== listed.createdAt || record.updatedAt !== listed.updatedAt ||
            outboundLaunchAttemptDigest(record.attempt) !== outboundLaunchAttemptDigest(attempt)) throw new Failure("mismatched");
        const related = attempt.requestRecallRef === recallRef || attempt.requestActionRef === request.actionRef ||
          attempt.approvalRef === request.approvalRef || attempt.effectRef === request.effectRef;
        if (related) {
          if (!outboundAttemptMatchesRequest(record.attempt,request,recallRef)) throw new Failure("mismatched");
          records.push(record);
        }
      }
      await accountPermit(); for (const q of grants.values()) await recordPermit(q);
      current(account); for (const q of grants.values()) current(q);
      return ok(Object.freeze({ kind: "possibleLaunchHistory", scanned, observedAt: clock(), records: Object.freeze(records) }));
    } catch (error) { return err({ kind: error instanceof Failure || error instanceof OwnedBodyError ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); deadline.abort(); }
  }
}
