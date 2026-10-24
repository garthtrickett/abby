import { createHash } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { LocationScope, Result } from "../core/model.ts";
import type { OutboundEffectBarrier as OneUseEffectBarrier } from "../core/outbound-effect-barrier.ts";
import { validOutboundEffectRef } from "../core/outbound-effect-barrier.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, clinikoCredentialFingerprint, isClinikoRequestBudget, observeCliniko429 } from "./read-budget.ts";
import type { ClinikoRequestBudget } from "./read-budget.ts";
import { AdministrativeMemoAuthentication, administrativeMemoDigest, decodeAdministrativeMemo, encodeAdministrativeMemo } from "./administrative-memo.ts";
import type { AdministrativeMemo } from "./administrative-memo.ts";
import { administrativeMemoNativeInstant as instant, matchesAdministrativeMemo, parseNativeAdministrativeMemo } from "./internal/administrative-memo-native.ts";

export type AdministrativeMemoConfig = Readonly<{
  scope: LocationScope; businessId: string; apiKey: string; contactEmail: string;
  authorRef: string; policy: Readonly<{ version: string; digest: string }>;
  rateBudget: ClinikoRequestBudget; clock?: () => string; deadlineMs?: number;
}>;
export type AdministrativeMemoBinding = Readonly<{ communicationRef: string; actionRef: string; patientId: string }>;
export type AdministrativeMemoQuery = Readonly<{
  operation: "createAdministrativeMemo" | "readAdministrativeMemo"; scope: LocationScope;
  businessId: string; credentialFingerprint: string; authorRef: string;
  policy: Readonly<{ version: string; digest: string }>; ownerBinding: string;
  authenticationBinding: string; categoryCode: 12; typeCode: 3; confidential: true;
  actionRef: string; patientId: string; communicationRef?: string; includeArchived?: true;
  memo?: AdministrativeMemo; memoDigest?: string;
}>;
export type AdministrativeMemoReadAuthority = Readonly<{
  allows(query: AdministrativeMemoQuery, signal: AbortSignal): Promise<boolean>;
  current(query: AdministrativeMemoQuery, signal: AbortSignal): boolean;
}>;
export type AdministrativeMemoWriteAuthority = AdministrativeMemoReadAuthority & Readonly<{
  /** Must establish the actual trusted workflow/subject receipt separately.
   * Knowing the MAC key or possessing patient proof does not satisfy this. */
  producerAdmitted(query: AdministrativeMemoQuery, signal: AbortSignal): Promise<boolean>;
}>;
export type AdministrativeMemoFailure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "alreadyClaimed" | "unavailable" | "rateLimited" | "malformed" | "mismatched" }>;
export type AdministrativeMemoRetention = Readonly<{ kind: "accepted"; communicationRef: string; actionRef: string }> |
  Readonly<{ kind: "acceptedWithheld" | "uncertain" }>;
export type NativeAdministrativeMemo = Readonly<{ kind: "nativeAdministrativeMemo"; communicationRef: string; memo: AdministrativeMemo;
  createdAt: string; updatedAt: string; archivedAt: string | null }>;
type NativeInput = Readonly<{ method: "POST"; memo: AdministrativeMemo; content: string }> | Readonly<{ method: "GET"; binding: AdministrativeMemoBinding }>;
const object = (v: unknown): Record<string, unknown> | undefined => !!v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const exact = (v: unknown, keys: readonly string[]) => !!object(v) && Object.keys(v as object).sort().join(",") === [...keys].sort().join(",");
const numeric = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,18}$/.test(v);
const opaque = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(v);
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function shard(c: AdministrativeMemoConfig, auth: AdministrativeMemoAuthentication, port: typeof fetch): string | undefined {
  try {
    const s = typeof c.apiKey === "string" ? /-([a-z]{2}[0-9]{1,2})$/.exec(c.apiKey)?.[1] : undefined;
    if (!s || c.apiKey.length > 4096 || !c.apiKey.slice(0, -(s.length + 1)) || /[\u0000-\u0020\u007f]/.test(c.apiKey) ||
        !exact(c.scope, ["tenantId", "clinicId", "locationId"]) || !Object.values(c.scope).every(opaque) || !numeric(c.businessId) || !opaque(c.authorRef) ||
        !exact(c.policy, ["version", "digest"]) || !opaque(c.policy.version) || !digest(c.policy.digest) ||
        typeof c.contactEmail !== "string" || c.contactEmail.length > 254 || !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(c.contactEmail) ||
        !(auth instanceof AdministrativeMemoAuthentication) || !isClinikoRequestBudget(c.rateBudget) || typeof port !== "function" ||
        c.clock !== undefined && typeof c.clock !== "function" || c.deadlineMs !== undefined && (!Number.isSafeInteger(c.deadlineMs) || c.deadlineMs < 1 || c.deadlineMs > 30000)) return;
    return s;
  } catch { return; }
}
export function administrativeMemoRecordBinding(c: AdministrativeMemoConfig, auth: AdministrativeMemoAuthentication): string | undefined {
  if (!shard(c, auth, fetch)) return;
  return createHash("sha256").update(JSON.stringify(["abby.administrative-memo-record.v1", c.scope.tenantId, c.scope.clinicId, c.scope.locationId,
    c.businessId, clinikoCredentialFingerprint(c.apiKey), c.authorRef, c.policy.version, c.policy.digest, auth.binding(), c.deadlineMs ?? 15000])).digest("hex");
}
class Failure extends Error {
  readonly kind: AdministrativeMemoFailure["kind"];
  constructor(kind: AdministrativeMemoFailure["kind"]) { super("Administrative memo unavailable"); this.kind = kind; }
}

/** A create-only native adapter, not a clinical-success or permission owner.
 * It never updates staff notes, sends a message, replays a claimed purpose, or
 * persists private data locally. Known receipt and current disclosure differ. */
export class ClinikoAdministrativeMemos {
  readonly #config: AdministrativeMemoConfig;
  readonly #base: string;
  readonly #owner: string;
  readonly #auth: AdministrativeMemoAuthentication;
  readonly #authority: AdministrativeMemoReadAuthority;
  readonly #producer: AdministrativeMemoWriteAuthority["producerAdmitted"] | undefined;
  readonly #barrier: OneUseEffectBarrier | undefined;
  readonly #fetch: typeof fetch;
  private constructor(c: AdministrativeMemoConfig, s: string, owner: string, auth: AdministrativeMemoAuthentication,
    authority: AdministrativeMemoReadAuthority, port: typeof fetch, write?: Readonly<{ authority: AdministrativeMemoWriteAuthority; barrier: OneUseEffectBarrier }>) {
    const b = c.rateBudget;
    this.#config = Object.freeze({ ...c, scope: Object.freeze({ ...c.scope }), policy: Object.freeze({ ...c.policy }),
      rateBudget: Object.freeze({ claim: b.claim.bind(b), observe429: b.observe429.bind(b) }), clock: c.clock?.bind(c) ?? (() => new Date().toISOString()) });
    this.#base = `https://api.${s}.cliniko.com/v1`; this.#owner = owner; this.#auth = auth; this.#fetch = port;
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), current: authority.current.bind(authority) });
    this.#producer = write?.authority.producerAdmitted.bind(write.authority);
    this.#barrier = write && Object.freeze({ matches: write.barrier.matches.bind(write.barrier), claimOnce: write.barrier.claimOnce.bind(write.barrier) });
  }
  static create(c: AdministrativeMemoConfig, auth: AdministrativeMemoAuthentication, authority: AdministrativeMemoWriteAuthority,
    barrier: OneUseEffectBarrier, port: typeof fetch = fetch): Result<ClinikoAdministrativeMemos, AdministrativeMemoFailure> {
    try {
      const s = shard(c, auth, port), owner = administrativeMemoRecordBinding(c, auth);
      if (!s || !owner || [authority?.allows, authority?.current, authority?.producerAdmitted, barrier?.matches, barrier?.claimOnce].some(f => typeof f !== "function") ||
          barrier.matches(c.scope, owner) !== true) return err({ kind: "invalidConfig" });
      return ok(new ClinikoAdministrativeMemos(c, s, owner, auth, authority, port, { authority, barrier }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  static createReadOnly(c: AdministrativeMemoConfig, auth: AdministrativeMemoAuthentication, authority: AdministrativeMemoReadAuthority,
    port: typeof fetch = fetch): Result<Pick<ClinikoAdministrativeMemos, "readMemo">, AdministrativeMemoFailure> {
    try {
      const s = shard(c, auth, port), owner = administrativeMemoRecordBinding(c, auth);
      if (!s || !owner || [authority?.allows, authority?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoAdministrativeMemos(c, s, owner, auth, authority, port));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #matches(m: AdministrativeMemo): boolean {
    return matchesAdministrativeMemo(m, this.#config, this.#auth);
  }
  #query(input: NativeInput, memo?: AdministrativeMemo): AdministrativeMemoQuery {
    const c = this.#config, selected = input.method === "POST" ? input.memo : input.binding;
    return Object.freeze({ operation: input.method === "POST" ? "createAdministrativeMemo" : "readAdministrativeMemo", scope: c.scope,
      businessId: c.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.apiKey), authorRef: c.authorRef, policy: c.policy,
      ownerBinding: this.#owner, authenticationBinding: this.#auth.binding(), categoryCode: 12, typeCode: 3, confidential: true,
      actionRef: selected.actionRef, patientId: selected.patientId, ...(input.method === "GET" ? { communicationRef: input.binding.communicationRef, includeArchived: true as const } : {}),
      ...(memo ? { memo, memoDigest: administrativeMemoDigest(memo)! } : {}) });
  }
  async retainOnce(memo: AdministrativeMemo, signal: AbortSignal): Promise<Result<AdministrativeMemoRetention, AdministrativeMemoFailure>> {
    try {
      const encoded = encodeAdministrativeMemo(memo); if (!encoded.ok || !this.#producer || !this.#barrier) return err({ kind: "invalidQuery" });
      const decoded = decodeAdministrativeMemo(encoded.value); if (!decoded.ok || !this.#matches(decoded.value)) return err({ kind: "invalidQuery" });
      const result = await this.#run({ method: "POST", memo: decoded.value, content: encoded.value }, signal);
      return result.ok && result.value.kind === "nativeAdministrativeMemo" ? err({ kind: "unavailable" }) : result as Result<AdministrativeMemoRetention, AdministrativeMemoFailure>;
    } catch { return err({ kind: "unavailable" }); }
  }
  async readMemo(binding: AdministrativeMemoBinding, signal: AbortSignal): Promise<Result<NativeAdministrativeMemo, AdministrativeMemoFailure>> {
    try {
      if (!exact(binding, ["communicationRef", "actionRef", "patientId"]) || !/^cliniko:communication:[1-9][0-9]{0,18}$/.test(binding.communicationRef) ||
          !validOutboundEffectRef(binding.actionRef) || !numeric(binding.patientId)) return err({ kind: "invalidQuery" });
      const result = await this.#run({ method: "GET", binding: Object.freeze({ ...binding }) }, signal);
      return result.ok && result.value.kind !== "nativeAdministrativeMemo" ? err({ kind: "unavailable" }) : result as Result<NativeAdministrativeMemo, AdministrativeMemoFailure>;
    } catch { return err({ kind: "unavailable" }); }
  }
  async #run(input: NativeInput, external: AbortSignal): Promise<Result<AdministrativeMemoRetention | NativeAdministrativeMemo, AdministrativeMemoFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const c = this.#config, controller = new AbortController(), ms = c.deadlineMs ?? 15000, signal = AbortSignal.any([external, controller.signal]);
    const timer = setTimeout(() => controller.abort(), ms), began = performance.now(), queries: AdministrativeMemoQuery[] = [];
    let last = "", dispatched = false, known: Extract<AdministrativeMemoRetention, { kind: "accepted" }> | undefined, response: Response | undefined;
    const clock = () => { const at = c.clock!(); if (instant(at) !== at || at < last) throw new Failure("unavailable"); last = at; return at; };
    const current = () => {
      if (signal.aborted || performance.now() - began > ms || queries.some(q => this.#authority.current(q, signal) !== true) ||
          input.method === "POST" && this.#barrier?.matches(c.scope, this.#owner) !== true) throw new Failure("forbidden"); clock();
    };
    const wait = async <T>(pending: Promise<T>) => { const v = await awaitUntilAbort(pending, signal); if (v === undefined) throw new Failure("unavailable"); current(); return v; };
    const permit = async (q: AdministrativeMemoQuery, producer = false) => {
      queries.push(q); current();
      if (await wait(Promise.resolve().then(() => this.#authority.allows(q, signal))) !== true ||
          producer && await wait(Promise.resolve().then(() => this.#producer!(q, signal))) !== true) throw new Failure("forbidden"); current();
    };
    try {
      const q = this.#query(input, input.method === "POST" ? input.memo : undefined); await permit(q, input.method === "POST");
      if (input.method === "POST") {
        if (input.memo.recordedAt > clock()) throw new Failure("invalidQuery");
        const claim = await wait(this.#barrier!.claimOnce(input.memo.actionRef));
        if (!claim.ok) throw new Failure("unavailable"); if (!claim.value.claimed) return err({ kind: "alreadyClaimed" });
      }
      const limited = await wait(claimClinikoBudget(c.rateBudget)); if (limited) return err({ kind: limited.kind });
      const url = input.method === "POST" ? `${this.#base}/communications` : `${this.#base}/communications/${input.binding.communicationRef.split(":")[2]}?q%5B%5D=archived_at%3A*`;
      const init: RequestInit = { method: input.method, redirect: "error", signal, headers: { Accept: "application/json", "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${c.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${c.contactEmail})` },
        ...(input.method === "POST" ? { body: JSON.stringify({ category_code: 12, confidential: true, content: input.content,
          direction_code: input.memo.direction === "outbound" ? 1 : 2,
          // Native memo metadata requires both parties. Role labels disclose
          // no contact details or claimed identity; signed direction owns them.
          from: input.memo.direction === "outbound" ? "Abby" : "Call participant",
          to: input.memo.direction === "outbound" ? "Call participant" : "Abby",
          patient_id: input.memo.patientId, type_code: 3 }) } : {}) };
      current(); dispatched = input.method === "POST";
      response = await wait(this.#fetch(url, init).then(r => { response = r; if (signal.aborted) { try { void r.body?.cancel().catch(() => {}); } catch {} } return r; }));
      if (response.status === 429) { await wait(observeCliniko429(c.rateBudget, response.headers.get("X-RateLimit-Reset"))); return dispatched ? ok({ kind: "uncertain" }) : err({ kind: "rateLimited" }); }
      if (response.status !== (dispatched ? 201 : 200)) throw new Failure(response.status === 401 || response.status === 403 ? "forbidden" : "unavailable");
      if (response.url && response.url !== url) throw new Failure("mismatched");
      const bytes = await ownedBodyBytes(response.body, 65536, signal);
      let raw: unknown; try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Failure("malformed"); }
      const selected = input.method === "POST" ? input.memo : input.binding;
      const found = parseNativeAdministrativeMemo(raw, { base: this.#base, config: c, authentication: this.#auth, clock,
        patientId: selected.patientId, actionRef: selected.actionRef,
        ...(input.method === "POST" ? { content: input.content } : { communicationRef: input.binding.communicationRef }) });
      if (!found) throw new Failure("mismatched");
      if (input.method === "POST") {
        known = Object.freeze({ kind: "accepted", communicationRef: found.communicationRef, actionRef: input.memo.actionRef });
        try { current(); return ok(known); } catch { return ok({ kind: "acceptedWithheld" }); }
      }
      await permit(this.#query(input, found.memo)); current();
      return ok(found);
    } catch (error) {
      if (known) return ok({ kind: "acceptedWithheld" });
      return dispatched ? ok({ kind: "uncertain" }) : err({ kind: error instanceof Failure ? error.kind : "unavailable" });
    } finally { clearTimeout(timer); controller.abort(); try { void response?.body?.cancel().catch(() => {}); } catch {} }
  }
}
