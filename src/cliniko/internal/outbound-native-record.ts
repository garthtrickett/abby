import { err, ok } from "../../core/model.ts";
import type { LocationScope, Result } from "../../core/model.ts";
import type { OutboundEffectBarrier } from "../../core/outbound-effect-barrier.ts";
import { awaitUntilAbort } from "../../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "../read-budget.ts";
import type { ClinikoRequestBudget } from "../read-budget.ts";
import { validRecallDate, validRecallMarker } from "../recall-note.ts";
import { outboundNativeInstant, outboundNativeId } from "./outbound-record-context.ts";

export type NativeOutboundFailure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "alreadyClaimed" | "unavailable" | "rateLimited" | "malformed" | "mismatched"; resetAt?: string }>;
export type NativeOutboundRetention = Readonly<{ kind: "accepted"; recallRef: string; actionRef: string }> | Readonly<{ kind: "uncertain" }>;
export type NativeOutboundReadBinding = Readonly<{ recallRef: string; actionRef: string; patientId: string }>;
export type NativeOutboundIdentity = Readonly<{ actionRef: string; patientId: string; scope: LocationScope; businessId: string; credentialFingerprint: string }>;
export type NativeOutboundContext<T> = Readonly<{ kind: "nativeOutboundContext"; recallRef: string; record: T; recallAt: string;
  createdAt: string; updatedAt: string; recalled: boolean; recalledAt: string | null; archivedAt: string | null }>;
export type NativeOutboundQueryInput<T> = Readonly<{ method: "POST" | "GET"; actionRef: string; patientId: string; recallRef?: string; recallAt?: string; record?: T }>;
export type NativeOutboundReadAuthority<Q> = Readonly<{ allows(query: Q, signal: AbortSignal): Promise<boolean>; current(query: Q, signal: AbortSignal): boolean }>;
export type NativeOutboundCodec<T> = Readonly<{ encode(record: T): Result<string, unknown>; decode(notes: unknown): Result<T, unknown>;
  recordedAt(record: T): string; expiresAt(record: T): string }>;
export type NativeOutboundConfig = Readonly<{ scope: LocationScope; businessId: string; credentialFingerprint: string; typeId: string;
  apiKey: string; contactEmail: string; rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number }>;
type NativeInput<T> = Readonly<{ method: "POST"; record: T; notes: string; recallAt: string }> | Readonly<{ method: "GET"; binding: NativeOutboundReadBinding }>;
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const link = (v: unknown) => object(object(v)?.links)?.self;
const recallId = (v: unknown) => typeof v === "string" ? /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(v)?.[1] : undefined;
class Failure extends Error {
  readonly kind: NativeOutboundFailure["kind"];
  constructor(kind: NativeOutboundFailure["kind"]) { super("Outbound record unavailable"); this.kind = kind; }
}
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* Own operation's body only. */ } }

/** Shared private native transport. Public adapters supply distinct validated
 * type/content selection, codec and operation-specific permission queries. */
export class NativeOutboundRecords<T extends NativeOutboundIdentity, Q> {
  readonly #selection: Pick<NativeOutboundConfig,"scope"|"businessId"|"credentialFingerprint">;
  readonly #typeId: string;
  readonly #owner: string;
  readonly #base: string;
  readonly #authorization: string;
  readonly #agent: string;
  readonly #read: NativeOutboundReadAuthority<Q>;
  readonly #producer: ((query: Q, signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly #barrier: OutboundEffectBarrier | undefined;
  readonly #budget: ClinikoRequestBudget;
  readonly #clock: () => string;
  readonly #deadlineMs: number;
  readonly #fetch: typeof fetch;
  readonly #codec: NativeOutboundCodec<T>;
  readonly #query: (input: NativeOutboundQueryInput<T>) => Q;
  constructor(config: NativeOutboundConfig, shard: string, owner: string, read: NativeOutboundReadAuthority<Q>, port: typeof fetch,
    codec: NativeOutboundCodec<T>, query: (input: NativeOutboundQueryInput<T>) => Q,
    write?: Readonly<{ producer(query: Q, signal: AbortSignal): Promise<boolean>; barrier: OutboundEffectBarrier }>) {
    this.#selection=Object.freeze({scope:Object.freeze({...config.scope}),businessId:config.businessId,credentialFingerprint:config.credentialFingerprint});
    this.#typeId=config.typeId;this.#owner=owner;this.#base=`https://api.${shard}.cliniko.com/v1`;
    this.#authorization=`Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`;this.#agent=`Abby (${config.contactEmail})`;
    this.#read=Object.freeze({allows:read.allows.bind(read),current:read.current.bind(read)});this.#producer=write?.producer;
    this.#barrier=write?Object.freeze({matches:write.barrier.matches.bind(write.barrier),claimOnce:write.barrier.claimOnce.bind(write.barrier)}):undefined;
    this.#budget=Object.freeze({claim:config.rateBudget.claim.bind(config.rateBudget),observe429:config.rateBudget.observe429.bind(config.rateBudget)});
    this.#clock=config.clock?.bind(config)??(()=>new Date().toISOString());this.#deadlineMs=config.deadlineMs??15000;this.#fetch=port;
    this.#codec=Object.freeze({encode:codec.encode.bind(codec),decode:codec.decode.bind(codec),recordedAt:codec.recordedAt.bind(codec),expiresAt:codec.expiresAt.bind(codec)});this.#query=query;
  }
  #matches(record: T): boolean {
    const s=this.#selection;return record.scope.tenantId===s.scope.tenantId&&record.scope.clinicId===s.scope.clinicId&&record.scope.locationId===s.scope.locationId&&
      record.businessId===s.businessId&&record.credentialFingerprint===s.credentialFingerprint;
  }
  async retain(input: T, recallAt: string, signal: AbortSignal): Promise<Result<NativeOutboundRetention, NativeOutboundFailure>> {
    if(!this.#barrier||!this.#producer)return err({kind:"forbidden"});
    const notes=this.#codec.encode(input);if(!notes.ok||!validRecallDate(recallAt))return err({kind:"invalidQuery"});
    const record=this.#codec.decode(notes.value);if(!record.ok||!this.#matches(record.value))return err({kind:"invalidQuery"});
    const result=await this.#perform({method:"POST",record:record.value,notes:notes.value,recallAt},signal);
    return !result.ok?result:result.value.kind==="uncertain"?ok(result.value):ok({kind:"accepted",recallRef:result.value.recallRef,actionRef:record.value.actionRef});
  }
  async read(input: NativeOutboundReadBinding, signal: AbortSignal): Promise<Result<NativeOutboundContext<T>,NativeOutboundFailure>> {
    try {
      const binding=Object.freeze({...input});
      if(Object.keys(binding).sort().join(",")!=="actionRef,patientId,recallRef"||!recallId(binding.recallRef)||!validRecallMarker(binding.actionRef)||!outboundNativeId(binding.patientId))return err({kind:"invalidQuery"});
      const result=await this.#perform({method:"GET",binding},signal);return !result.ok?result:result.value.kind==="uncertain"?err({kind:"unavailable"}):ok(result.value);
    }catch{return err({kind:"invalidQuery"});}
  }
  async #perform(input: NativeInput<T>, external: AbortSignal): Promise<Result<NativeOutboundContext<T> | Readonly<{ kind: "uncertain" }>, NativeOutboundFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#deadlineMs), began = performance.now();
    const signal = AbortSignal.any([external, deadline.signal]);
    let dispatched = false, responseOwned: Response | undefined, bodyOwned = false;
    const makeQuery = (record?: T): Q => this.#query(Object.freeze({ method: input.method,
      actionRef: input.method === "POST" ? input.record.actionRef : input.binding.actionRef,
      patientId: input.method === "POST" ? input.record.patientId : input.binding.patientId,
      ...(input.method === "POST" ? { recallAt: input.recallAt, record: input.record } : { recallRef: input.binding.recallRef, ...(record ? { record } : {}) }) }));
    let query = makeQuery();
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
        if (input.method === "POST" && (at < this.#codec.recordedAt(input.record) || at >= this.#codec.expiresAt(input.record))) throw new Failure("forbidden");
        return at;
      };
      fresh(); await permit(); fresh();
      if (input.method === "POST") {
        if (!this.#barrier || !this.#producer || this.#barrier.matches(this.#selection.scope, this.#owner) !== true) throw new Failure("forbidden");
        const claim = await wait(this.#barrier.claimOnce(input.record.actionRef));
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
        ...(input.method === "POST" ? { body: JSON.stringify({ patient_id: input.record.patientId, recall_type_id: this.#typeId,
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
          link(row.patient) !== `${this.#base}/patients/${(input.method === "POST" ? input.record.patientId : input.binding.patientId)}` || link(row.recall_type) !== `${this.#base}/recall_types/${this.#typeId}` ||
          typeof row.notes !== "string" || row.notes.length > 1050 || !validRecallDate(row.recall_at) || typeof row.recalled !== "boolean" ||
          !createdAt || !updatedAt || createdAt > updatedAt || recalledAt === undefined || archivedAt === undefined ||
          input.method === "GET" && row.id !== id || input.method === "POST" && (row.notes !== input.notes || row.recall_at !== input.recallAt || row.recalled || recalledAt !== null || archivedAt !== null)) throw new Failure("mismatched");
      const request = this.#codec.decode(row.notes);
      if (!request.ok || !this.#matches(request.value) || request.value.actionRef !== (input.method === "POST" ? input.record.actionRef : input.binding.actionRef) || request.value.patientId !== (input.method === "POST" ? input.record.patientId : input.binding.patientId) ||
          Date.parse(createdAt) < Date.parse(this.#codec.recordedAt(request.value))-30_000 || createdAt >= this.#codec.expiresAt(request.value)) throw new Failure("mismatched");
      const observedAt = now();
      if (observedAt < beganAt || Date.parse(updatedAt) > Date.parse(observedAt)+30_000 || !active()) throw new Failure("unavailable");
      if (input.method === "GET") {
        query = makeQuery(request.value);
        await permit(); if (now() < observedAt) throw new Failure("unavailable"); current();
      }
      return ok(Object.freeze({ kind: "nativeOutboundContext", recallRef: `cliniko:recall:${row.id}`, record: request.value,
        recallAt: row.recall_at, createdAt, updatedAt, recalled: row.recalled, recalledAt, archivedAt }));
    } catch (error) {
      return dispatched ? ok({ kind: "uncertain" }) : err({ kind: error instanceof Failure ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); deadline.abort(); if (!bodyOwned) discard(responseOwned); }
  }
}
