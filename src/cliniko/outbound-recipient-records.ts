import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { OutboundEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { validRecallDate, validRecallMarker } from "./recall-note.ts";
import { encodeOutboundRecipientRequest, decodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "./outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "./outbound-recipient-request.ts";
import { outboundConfigShard, outboundRecordSelection, outboundRecordOwnerBinding, outboundNativeInstant, outboundNativeId } from "./internal/outbound-record-context.ts";
import type { OutboundRecordConfig, OutboundRecordSelection } from "./internal/outbound-record-context.ts";
export type { OutboundRecordConfig, OutboundRecordSelection } from "./internal/outbound-record-context.ts";
export { outboundRecordOwnerBinding } from "./internal/outbound-record-context.ts";

export type OutboundRecordQuery = OutboundRecordSelection & Readonly<{
  ownerBinding: string; operation: "retainRecipientRequest" | "readRecipientRequest";
  actionRef: string; patientId: string; recallRef?: string; recallAt?: string;
  request?: OutboundRecipientRequest; requestDigest?: string;
}>;
/** Independent native-record grants. These grant no audience/contact/DNC,
 * campaign/launch/patient authority. Reads need no effect-producer admission. */
export type OutboundRecordReadAuthority = Readonly<{
  allows(query: OutboundRecordQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundRecordQuery, signal: AbortSignal): boolean;
}>;
export type OutboundRecordAuthority = OutboundRecordReadAuthority & Readonly<{
  producerAdmitted(query: OutboundRecordQuery, signal: AbortSignal): Promise<boolean>;
}>;
export type OutboundRecordFailure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "alreadyClaimed" | "unavailable" | "rateLimited" | "malformed" | "mismatched"; resetAt?: string }>;
export type OutboundRecipientRecord = Readonly<{ kind: "recipientRequestContext"; recallRef: string; request: OutboundRecipientRequest;
  recallAt: string; createdAt: string; updatedAt: string; recalled: boolean; recalledAt: string | null; archivedAt: string | null }>;
export type OutboundRecordRetention = Readonly<{ kind: "accepted"; recallRef: string; actionRef: string }> | Readonly<{ kind: "uncertain" }>;
type ReadBinding = Readonly<{ recallRef: string; actionRef: string; patientId: string }>;
type Input = Readonly<{ method: "POST"; request: OutboundRecipientRequest; notes: string; recallAt: string }> |
  Readonly<{ method: "GET"; binding: ReadBinding }>;
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const link = (v: unknown) => object(object(v)?.links)?.self;
const recallId = (v: unknown) => typeof v === "string" ? /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(v)?.[1] : undefined;
class Failure extends Error {
  readonly kind: OutboundRecordFailure["kind"];
  constructor(kind: OutboundRecordFailure["kind"]) { super("Outbound record unavailable"); this.kind = kind; }
}
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* Own operation's body only. */ } }

/** Exact native private request create/read. No schedule/launch is performed. */
export class ClinikoOutboundRecipientRecords {
  readonly #selection: OutboundRecordSelection;
  readonly #owner: string;
  readonly #base: string;
  readonly #authorization: string;
  readonly #agent: string;
  readonly #read: OutboundRecordReadAuthority;
  readonly #producer: OutboundRecordAuthority["producerAdmitted"] | undefined;
  readonly #barrier: OutboundEffectBarrier | undefined;
  readonly #budget: ClinikoRequestBudget;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  readonly #fetch: typeof fetch;
  private constructor(config: OutboundRecordConfig, shard: string, owner: string, read: OutboundRecordReadAuthority,
    port: typeof fetch, write?: Readonly<{ producer: OutboundRecordAuthority["producerAdmitted"]; barrier: OutboundEffectBarrier }>) {
    this.#selection = outboundRecordSelection(config); this.#owner = owner; this.#base = `https://api.${shard}.cliniko.com/v1`;
    this.#authorization = `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`; this.#agent = `Abby (${config.contactEmail})`;
    this.#read = Object.freeze({ allows: read.allows.bind(read), current: read.current.bind(read) });
    this.#producer = write?.producer;
    this.#barrier = write ? Object.freeze({ matches: write.barrier.matches.bind(write.barrier), claimOnce: write.barrier.claimOnce.bind(write.barrier) }) : undefined;
    this.#budget = Object.freeze({ claim: config.rateBudget.claim.bind(config.rateBudget), observe429: config.rateBudget.observe429.bind(config.rateBudget) });
    this.#clock = config.clock?.bind(config) ?? (() => new Date().toISOString()); this.#deadlineMs = config.deadlineMs ?? 15000; this.#fetch = port;
  }
  static create(config: OutboundRecordConfig, authority: OutboundRecordAuthority, barrier: OutboundEffectBarrier,
    port: typeof fetch = fetch): Result<ClinikoOutboundRecipientRecords, OutboundRecordFailure> {
    try {
      const shard = outboundConfigShard(config, port), owner = outboundRecordOwnerBinding(config);
      if (!shard || !owner || [authority?.allows, authority?.current, authority?.producerAdmitted, barrier?.matches, barrier?.claimOnce].some(f => typeof f !== "function") ||
          barrier.matches(config.scope, owner) !== true) return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundRecipientRecords(config, shard, owner, authority, port, { producer: authority.producerAdmitted.bind(authority), barrier }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  static createReadOnly(config: OutboundRecordConfig, authority: OutboundRecordReadAuthority,
    port: typeof fetch = fetch): Result<Pick<ClinikoOutboundRecipientRecords, "readRequest">, OutboundRecordFailure> {
    try {
      const shard = outboundConfigShard(config, port), owner = outboundRecordOwnerBinding(config);
      if (!shard || !owner || typeof authority?.allows !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundRecipientRecords(config, shard, owner, authority, port));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #matches(r: OutboundRecipientRequest): boolean {
    const s = this.#selection;
    return r.scope.tenantId === s.scope.tenantId && r.scope.clinicId === s.scope.clinicId && r.scope.locationId === s.scope.locationId &&
      r.businessId === s.businessId && r.credentialFingerprint === s.credentialFingerprint;
  }
  async retainRequestOnce(input: OutboundRecipientRequest, recallAt: string, signal: AbortSignal): Promise<Result<OutboundRecordRetention, OutboundRecordFailure>> {
    if (!this.#barrier || !this.#producer) return err({ kind: "forbidden" });
    const notes = encodeOutboundRecipientRequest(input); if (!notes.ok || !validRecallDate(recallAt)) return err({ kind: "invalidQuery" });
    const request = decodeOutboundRecipientRequest(notes.value); if (!request.ok || !this.#matches(request.value)) return err({ kind: "invalidQuery" });
    const result = await this.#perform({ method: "POST", request: request.value, notes: notes.value, recallAt }, signal);
    return !result.ok ? result : result.value.kind === "uncertain" ? ok(result.value) : ok({ kind: "accepted", recallRef: result.value.recallRef, actionRef: request.value.actionRef });
  }
  async readRequest(input: ReadBinding, signal: AbortSignal): Promise<Result<OutboundRecipientRecord, OutboundRecordFailure>> {
    try {
      const b = Object.freeze({ ...input });
      if (Object.keys(b).sort().join(",") !== "actionRef,patientId,recallRef" || !recallId(b.recallRef) || !validRecallMarker(b.actionRef) || !outboundNativeId(b.patientId)) return err({ kind: "invalidQuery" });
      const found = await this.#perform({ method: "GET", binding: b }, signal);
      return !found.ok ? found : found.value.kind === "uncertain" ? err({ kind: "unavailable" }) : ok(found.value);
    } catch { return err({ kind: "invalidQuery" }); }
  }
  async #perform(input: Input, external: AbortSignal): Promise<Result<OutboundRecipientRecord | Readonly<{ kind: "uncertain" }>, OutboundRecordFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#deadlineMs), began = performance.now();
    const signal = AbortSignal.any([external, deadline.signal]);
    let dispatched = false, responseOwned: Response | undefined, bodyOwned = false;
    let query: OutboundRecordQuery = Object.freeze({ ...this.#selection, ownerBinding: this.#owner,
      ...(input.method === "POST" ? { operation: "retainRecipientRequest" as const, actionRef: input.request.actionRef, patientId: input.request.patientId,
        recallAt: input.recallAt, request: input.request, requestDigest: outboundRecipientRequestDigest(input.request)! }
        : { operation: "readRecipientRequest" as const, actionRef: input.binding.actionRef, patientId: input.binding.patientId, recallRef: input.binding.recallRef }) });
    const active = () => !signal.aborted && performance.now()-began <= this.#deadlineMs;
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const value = await awaitUntilAbort(task, signal); if (value === undefined || !active()) throw new Failure("unavailable"); return value;
    };
    const current = () => { if (!active() || this.#read.current(query, signal) !== true || !active()) throw new Failure("forbidden"); };
    const permit = async () => {
      current();
      if (await wait(Promise.resolve().then(() => this.#read.allows(query, signal))) !== true) throw new Failure("forbidden");
      current();
      if (input.method === "POST") {
        if (!this.#producer || await wait(Promise.resolve().then(() => this.#producer!(query, signal))) !== true) throw new Failure("forbidden");
        current();
      }
    };
    const now = () => {
      const raw = this.#clock(), canonical = outboundNativeInstant(raw);
      if (!canonical || canonical !== raw) throw new Failure("unavailable"); return canonical;
    };
    try {
      const beganAt = now();
      const fresh = () => {
        const at = now(); if (at < beganAt) throw new Failure("unavailable");
        if (input.method === "POST" && (at < input.request.requestedAt || at >= input.request.schedule.expiresAt)) throw new Failure("forbidden");
        return at;
      };
      fresh(); await permit(); fresh();
      if (input.method === "POST") {
        if (!this.#barrier || !this.#producer || this.#barrier.matches(this.#selection.scope, this.#owner) !== true) throw new Failure("forbidden");
        const claim = await wait(this.#barrier.claimOnce(input.request.actionRef));
        if (claim?.ok !== true || claim.value?.claimed !== true) throw new Failure(claim?.ok === true && claim.value?.claimed === false ? "alreadyClaimed" : "unavailable");
      }
      const limited = await wait(claimClinikoBudget(this.#budget)); if (limited) return err(limited);
      await permit(); fresh();
      if (input.method === "POST" && this.#barrier?.matches(this.#selection.scope, this.#owner) !== true) throw new Failure("forbidden");
      current();
      const id = input.method === "GET" ? recallId(input.binding.recallRef)! : undefined;
      const url = `${this.#base}/recalls${id ? `/${id}` : ""}`;
      const init: RequestInit = { method: input.method, redirect: "error", signal,
        headers: { Accept: "application/json", Authorization: this.#authorization, "Content-Type": "application/json", "User-Agent": this.#agent },
        ...(input.method === "POST" ? { body: JSON.stringify({ patient_id: query.patientId, recall_type_id: this.#selection.outboundRecallTypeId,
          recall_at: input.recallAt, notes: input.notes, recalled: false }) } : {}) };
      current(); dispatched = input.method === "POST";
      const response = await wait(this.#fetch(url, init).then(r => { responseOwned = r; if (signal.aborted) discard(r); return r; }));
      if (response.status === 429) {
        const reset = await wait(observeCliniko429(this.#budget, response.headers.get("X-RateLimit-Reset")));
        return dispatched ? ok({ kind: "uncertain" }) : err(reset);
      }
      if (response.status !== (dispatched ? 201 : 200)) return dispatched ? ok({ kind: "uncertain" }) : err({ kind: response.status === 401 || response.status === 403 ? "forbidden" : "unavailable" });
      bodyOwned = true; const bytes = await ownedBodyBytes(response.body, 1_000_000, signal);
      let raw: unknown; try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Failure("malformed"); }
      const row = object(raw), createdAt = outboundNativeInstant(row?.created_at), updatedAt = outboundNativeInstant(row?.updated_at),
        recalledAt = row?.recalled_at === null ? null : outboundNativeInstant(row?.recalled_at),
        archivedAt = row?.archived_at === null ? null : outboundNativeInstant(row?.archived_at);
      if (!row || !outboundNativeId(row.id) || link(row) !== `${this.#base}/recalls/${row.id}` ||
          link(row.patient) !== `${this.#base}/patients/${query.patientId}` || link(row.recall_type) !== `${this.#base}/recall_types/${this.#selection.outboundRecallTypeId}` ||
          typeof row.notes !== "string" || row.notes.length > 1050 || !validRecallDate(row.recall_at) || typeof row.recalled !== "boolean" ||
          !createdAt || !updatedAt || createdAt > updatedAt || recalledAt === undefined || archivedAt === undefined ||
          input.method === "GET" && row.id !== id || input.method === "POST" && (row.notes !== input.notes || row.recall_at !== input.recallAt || row.recalled || recalledAt !== null || archivedAt !== null)) throw new Failure("mismatched");
      const request = decodeOutboundRecipientRequest(row.notes);
      if (!request.ok || !this.#matches(request.value) || request.value.actionRef !== query.actionRef || request.value.patientId !== query.patientId ||
          Date.parse(createdAt) < Date.parse(request.value.requestedAt)-30_000 || createdAt >= request.value.schedule.expiresAt) throw new Failure("mismatched");
      const observedAt = now();
      if (observedAt < beganAt || Date.parse(updatedAt) > Date.parse(observedAt)+30_000 || !active()) throw new Failure("unavailable");
      if (input.method === "GET") {
        query = Object.freeze({ ...query, request: request.value, requestDigest: outboundRecipientRequestDigest(request.value)! });
        await permit(); if (now() < observedAt) throw new Failure("unavailable"); current();
      }
      return ok(Object.freeze({ kind: "recipientRequestContext", recallRef: `cliniko:recall:${row.id}`, request: request.value,
        recallAt: row.recall_at, createdAt, updatedAt, recalled: row.recalled, recalledAt, archivedAt }));
    } catch (error) {
      return dispatched ? ok({ kind: "uncertain" }) : err({ kind: error instanceof Failure ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); deadline.abort(); if (!bodyOwned) discard(responseOwned); }
  }
}
