import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes, OwnedBodyError } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, checkClinikoHeadroom, observeCliniko429, clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import { outboundConfigShard, outboundNativeInstant } from "../cliniko/internal/outbound-record-context.ts";
import type { OutboundRecordConfig } from "../cliniko/internal/outbound-record-context.ts";
import { contactSourceBinding } from "../cliniko/internal/outbound-contact-source-context.ts";
import type { OutboundContactSourceSelection } from "../cliniko/internal/outbound-contact-source-context.ts";
import { readAccountRecallHistory, PatientRecallHistoryError } from "../cliniko/internal/patient-recall-history.ts";
import type { AccountRecallRow } from "../cliniko/internal/patient-recall-history.ts";
import { NativeOutboundRecords } from "../cliniko/internal/outbound-native-record.ts";
import { decodeOutboundContactReview, encodeOutboundContactReview, outboundContactReviewDigest, hasOutboundContactReviewMarker } from "../cliniko/outbound-contact-review.ts";
import type { OutboundContactReview } from "../cliniko/outbound-contact-review.ts";
import { evaluateOutboundContactHistory } from "../cliniko/outbound-contact-lineage.ts";
import { encodeOutboundRecipientRequest, decodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "../cliniko/outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "../cliniko/outbound-recipient-request.ts";
import { OwnerFileOutboundContactAccount } from "./owner-file-outbound-contact-account.ts";
import type { OutboundContactAccount } from "./owner-file-outbound-contact-account.ts";

export type OutboundNumberReview = Readonly<{ recallRef: string; review: OutboundContactReview; digest: string }>;
type Base = Readonly<{ account: OutboundContactAccount; accountBinding: string; requestSource: OutboundContactSourceSelection; transportCredentialFingerprint: string; requestDigest: string; number: string; purpose: "followUp" | "sickDay" }>;
export type OutboundNumberStopQuery = Base & (
  Readonly<{ operation: "readAccountContactHistory"; includeArchived: true; includeClosed: true }> |
  Readonly<{ operation: "readContactNumberReview"; source: OutboundContactSourceSelection; recallRef: string; actionRef: string; patientId: string; review?: OutboundContactReview; digest?: string }> |
  Readonly<{ operation: "approveContactNumberHead" | "approveNumberReconsent"; source: OutboundContactSourceSelection; entry: OutboundNumberReview }> |
  Readonly<{ operation: "approveNumberStopResolution"; source: OutboundContactSourceSelection; stop: OutboundNumberReview; head: OutboundNumberReview; resolution: OutboundNumberReview }>
);
export type OutboundNumberStopAuthority = Readonly<{ allows(query: OutboundNumberStopQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundNumberStopQuery, signal: AbortSignal): boolean }>;
export type OutboundNumberStopConfig = Readonly<{ requests: OutboundRecordConfig; source: OutboundContactSourceSelection;
  account: OwnerFileOutboundContactAccount; maximumNativeRequests: number }>;
export type OutboundNumberStopEvidence = Readonly<{ kind: "nativeNumberStopEvidence"; disposition: "blocked" | "noRecordedStopObserved";
  observedAt: string; requestDigest: string; accountBinding: string }>;
type Failure = Readonly<{ kind: "invalidConfig" | "invalidQuery" | "forbidden" | "unavailable" | "malformed" | "mismatched" | "rateLimited" }>;
class Refusal extends Error { readonly kind: Failure["kind"]; constructor(kind: Failure["kind"]) { super("Native number stop evidence unavailable"); this.kind = kind; } }
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* Only owned response. */ } }

/** Current bounded native observation across the clinic's explicitly complete
 * source-role set. No patient verification, call grant, provider/unretained-stop
 * absence proof, local private cache or new native write is supplied. Closed,
 * archived or expired stop decisions never become an automatic clearance. */
export class ClinikoOutboundNumberStops {
  readonly #config: OutboundNumberStopConfig;
  readonly #authority: OutboundNumberStopAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #accountCurrent: OwnerFileOutboundContactAccount["current"];
  readonly #binding: string;
  private constructor(config: OutboundNumberStopConfig, authority: OutboundNumberStopAuthority, port: typeof fetch, shard: string) {
    const r = config.requests;
    this.#config = Object.freeze({ ...config, source: Object.freeze({ ...config.source, scope: Object.freeze({ ...config.source.scope }) }),
      requests: Object.freeze({ ...r, scope: Object.freeze({ ...r.scope }), ...(r.clock ? { clock: r.clock.bind(r) } : {}), rateBudget: Object.freeze({
        claim: r.rateBudget.claim.bind(r.rateBudget), observe429: r.rateBudget.observe429.bind(r.rateBudget),
        ...(r.rateBudget.checkHeadroom ? { checkHeadroom: r.rateBudget.checkHeadroom.bind(r.rateBudget) } : {}) }) }) });
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), current: authority.current.bind(authority) });
    this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`; this.#accountCurrent = config.account.current.bind(config.account); this.#binding = config.account.bindingFingerprint();
  }
  static create(c: OutboundNumberStopConfig, authority: OutboundNumberStopAuthority, port: typeof fetch = fetch): Result<ClinikoOutboundNumberStops, Failure> {
    try {
      const shard = outboundConfigShard(c.requests, port);
      if (!shard || !(c.account instanceof OwnerFileOutboundContactAccount) || !c.account.matches(c.requests.scope, clinikoCredentialFingerprint(c.requests.apiKey)) ||
          !Number.isSafeInteger(c.maximumNativeRequests) || c.maximumNativeRequests < 1 || c.maximumNativeRequests > 180 ||
          typeof authority.allows !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundNumberStops(c, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async readForRequest(input: OutboundRecipientRequest, external: AbortSignal): Promise<Result<OutboundNumberStopEvidence, Failure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const encoded = encodeOutboundRecipientRequest(input); if (!encoded.ok) return err({ kind: "invalidQuery" });
    const decoded = decodeOutboundRecipientRequest(encoded.value); if (!decoded.ok) return err({ kind: "invalidQuery" });
    const request = decoded.value, c = this.#config, r = c.requests;
    if (!isDeepStrictEqual(request.scope, r.scope) || request.businessId !== r.businessId || request.credentialFingerprint !== clinikoCredentialFingerprint(r.apiKey)) return err({ kind: "invalidQuery" });
    const controller = new AbortController(), ms = r.deadlineMs ?? 15000, timer = setTimeout(() => controller.abort(), ms), signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    const grants = new Map<string, OutboundNumberStopQuery>(); let last = "", base: Base | undefined;
    const now = () => { const at = r.clock ? r.clock() : new Date().toISOString();
      if (signal.aborted || performance.now() - began > ms || typeof at !== "string" || outboundNativeInstant(at) !== at || at < last) throw new Refusal("unavailable"); last = at; return at; };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const value = await awaitUntilAbort(task, signal); if (value === undefined) throw new Refusal("unavailable"); now(); return value; };
    const current = (q: OutboundNumberStopQuery) => { now(); if (this.#authority.current(q, signal) !== true) throw new Refusal("forbidden"); now(); };
    const definition = async () => {
      const found = await wait(this.#accountCurrent(signal)); if (!found.ok || !found.value) throw new Refusal("unavailable");
      const account = found.value.account;
      if (base && !isDeepStrictEqual(base.account, account) || !account.sources.some(s => isDeepStrictEqual(s, c.source))) throw new Refusal("mismatched");
      base ??= Object.freeze({ account, accountBinding: this.#binding, requestSource: c.source, transportCredentialFingerprint: request.credentialFingerprint, requestDigest: outboundRecipientRequestDigest(request)!, number: request.recipient.number, purpose: request.purpose });
    };
    const permit = async (q: OutboundNumberStopQuery) => {
      current(q); if (await wait(Promise.resolve().then(() => this.#authority.allows(q, signal))) !== true) throw new Refusal("forbidden"); current(q);
      const key = q.operation === "readContactNumberReview" ? q.recallRef : q.operation === "readAccountContactHistory" ? q.operation : q.operation + ":" + ("entry" in q ? q.entry.review.actionRef : q.stop.review.actionRef);
      const old = grants.get(key); if (!(q.operation === "readContactNumberReview" && !q.review && old?.operation === "readContactNumberReview" && old.review)) grants.set(key, q);
    };
    try {
      now(); const headroom = await wait(checkClinikoHeadroom(r.rateBudget, c.maximumNativeRequests)); if (headroom) throw new Refusal(headroom.kind);
      await definition(); const collection = Object.freeze({ ...base!, operation: "readAccountContactHistory" as const, includeArchived: true as const, includeClosed: true as const });
      const get = async (url: string) => {
        await definition(); await permit(collection); const limited = await wait(claimClinikoBudget(r.rateBudget)); if (limited) throw new Refusal(limited.kind);
        await definition(); await permit(collection); let response: Response | undefined, owned = false;
        try {
          current(collection); now(); const found = await wait(this.#fetch(url, { method: "GET", redirect: "error", signal, headers: { Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`${r.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${r.contactEmail})` } }).then(result => { response = result; if (signal.aborted) discard(result); return result; }));
          if (found.status === 429) { await wait(observeCliniko429(r.rateBudget, found.headers.get("X-RateLimit-Reset"))); throw new Refusal("rateLimited"); }
          if (found.status === 401 || found.status === 403) throw new Refusal("forbidden"); if (found.status !== 200) throw new Refusal("unavailable");
          owned = true; const bytes = await wait(ownedBodyBytes(found.body, 1000000, signal)); let raw: unknown;
          try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Refusal("malformed"); }
          await definition(); await permit(collection);
          // Inspect the already-authorized broad body before local type
          // filtering. A retired/unknown contact role must not disappear merely
          // because provisioning omitted its type from the current source set.
          const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
          if (Array.isArray(envelope?.recalls)) for (const value of envelope.recalls) {
            const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
            if (!hasOutboundContactReviewMarker(row?.notes)) continue;
            const type = row?.recall_type as { links?: { self?: unknown } } | undefined;
            if (!base!.account.sources.some(s => type?.links?.self === `${this.#base}/recall_types/${s.contactReviewRecallTypeId}`)) throw new Refusal("mismatched");
          }
          return raw;
        } finally { if (!owned) discard(response); }
      };
      const scan = () => readAccountRecallHistory({ base: this.#base, typeIds: [...new Set(base!.account.sources.map(s => s.contactReviewRecallTypeId))] }, get, now);
      const history = await scan(), entries: { entry: OutboundNumberReview; native: AccountRecallRow; source: OutboundContactSourceSelection }[] = [], ids = new Set<string>();

      for (const row of history.rows) {
        const parsed = decodeOutboundContactReview(row.notes); if (!parsed.ok) throw new Refusal("malformed");
        const review = parsed.value;
        const source = base!.account.sources.find(s => isDeepStrictEqual(s.scope, review.scope) && s.businessId === review.businessId &&
          s.credentialFingerprint === review.credentialFingerprint && s.contactReviewRecallTypeId === row.typeId && review.contactRecallTypeId === row.typeId &&
          s.contactPolicyVersion === review.policy.version && s.contactPolicyDigest === review.policy.digest);
        if (!source || review.patientId !== row.patientId) throw new Refusal("mismatched");
        if (ids.has(review.actionRef)) throw new Refusal("mismatched"); ids.add(review.actionRef);
        const records = new NativeOutboundRecords<OutboundContactReview, OutboundNumberStopQuery>({ ...r, scope: source.scope,
          businessId: source.businessId, credentialFingerprint: source.credentialFingerprint, typeId: source.contactReviewRecallTypeId }, this.#base.split(".")[1]!, contactSourceBinding(source), {
          allows: async q => { await definition(); await permit(collection); await permit(q); return true; },
          current: q => { try { current(collection); current(q); return true; } catch { return false; } },
        }, this.#fetch, { encode: encodeOutboundContactReview, decode: decodeOutboundContactReview, recordedAt: x => x.reviewedAt, expiresAt: x => x.effectiveUntil },
        q => Object.freeze({ ...base!, operation: "readContactNumberReview", source, recallRef: q.recallRef!, actionRef: q.actionRef, patientId: q.patientId,
          ...(q.record ? { review: q.record, digest: outboundContactReviewDigest(q.record)! } : {}) }));
        const found = await wait(records.read({ recallRef: `cliniko:recall:${row.id}`, actionRef: review.actionRef, patientId: row.patientId }, signal));
        if (!found.ok) throw new Refusal(found.error.kind === "rateLimited" ? "rateLimited" : found.error.kind === "forbidden" ? "forbidden" : "unavailable");
        const n = found.value;
        if (n.createdAt !== row.createdAt || n.updatedAt !== row.updatedAt || n.recalled !== row.recalled || n.recalledAt !== row.recalledAt ||
          n.archivedAt !== row.archivedAt || n.recallAt !== row.recallAt || outboundContactReviewDigest(n.record) !== outboundContactReviewDigest(review)) throw new Refusal("mismatched");
        entries.push({ source, native: row, entry: Object.freeze({ recallRef: n.recallRef, review: n.record, digest: outboundContactReviewDigest(n.record)! }) });
      }
      const groups = new Map<string, typeof entries>();
      for (const e of entries) { const key = contactSourceBinding(e.source) + ":" + e.entry.review.patientId;
        const group = groups.get(key) ?? []; group.push(e); groups.set(key, group); }
      let blocked = false; const clearedHeads: OutboundContactReview[] = [];
      for (const group of groups.values()) {
        const source = group[0]!.source, parents = new Set(group.flatMap(e => e.entry.review.predecessor ? [e.entry.review.predecessor.actionRef] : []));
        const heads = group.filter(e => !parents.has(e.entry.review.actionRef)); if (heads.length !== 1) throw new Refusal("mismatched");
        const head = heads[0]!, h = head.entry.review, lineage = evaluateOutboundContactHistory(group.map(e => e.entry.review), { actionRef: h.actionRef, digest: head.entry.digest }, now());
        if (!lineage.ok) throw new Refusal("mismatched");
        const stops = group.filter(e => e.entry.review.recipient.number === request.recipient.number && e.entry.review.doNotCall !== "clear");
        if (!stops.length) continue;
        await permit(Object.freeze({ ...base!, operation: "approveContactNumberHead", source, entry: head.entry }));
        // Closure/archive/expiry cannot erase a restrictive decision. A later
        // independently approved current same-number reconsent is necessary.
        const clear = lineage.value.disposition === "eligibleEvidence" && !head.native.recalled && head.native.archivedAt === null &&
          h.recipient.number === request.recipient.number && h.purposes.includes(request.purpose);
        if (!clear) { blocked = true; continue; }
        clearedHeads.push(h);
        for (const e of group) if (e.entry.review.reconsentApprovalRef)
          await permit(Object.freeze({ ...base!, operation: "approveNumberReconsent", source, entry: e.entry }));
        for (const stop of stops) {
          const resolution = [...group].sort((a, b) => a.entry.review.revision - b.entry.review.revision).find(e =>
            e.entry.review.revision > stop.entry.review.revision && e.entry.review.recipient.number === request.recipient.number &&
            e.entry.review.consent === "granted" && e.entry.review.doNotCall === "clear" && e.entry.review.reconsentApprovalRef !== null && e.entry.review.purposes.includes(request.purpose));
          if (!resolution) { blocked = true; continue; }
          await permit(Object.freeze({ ...base!, operation: "approveNumberStopResolution", source, stop: stop.entry, head: head.entry, resolution: resolution.entry }));
        }
      }
      for (const q of [...grants.values()]) await permit(q);
      await definition(); if (!isDeepStrictEqual(await scan(), history)) throw new Refusal("mismatched");
      await definition(); for (const q of grants.values()) current(q);
      const observedAt = now();
      if (clearedHeads.some(h => h.effectiveFrom > observedAt || observedAt >= h.effectiveUntil)) blocked = true;
      return ok(Object.freeze({ kind: "nativeNumberStopEvidence", disposition: blocked ? "blocked" : "noRecordedStopObserved",
        observedAt, requestDigest: base!.requestDigest, accountBinding: this.#binding }));
    } catch (error) { return err({ kind: error instanceof Refusal || error instanceof OwnedBodyError || error instanceof PatientRecallHistoryError ? error.kind : "unavailable" }); }
    finally { clearTimeout(timer); controller.abort(); }
  }
}
