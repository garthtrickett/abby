import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { ownedBodyBytes, OwnedBodyError } from "../shared/owned-body-bytes.ts";
import { claimClinikoBudget, observeCliniko429 } from "./read-budget.ts";
import { normalizePatientPhone } from "./phone-number.ts";
import { outboundNativeInstant } from "./internal/outbound-record-context.ts";
import { contactSourceShard, contactSourceSelection, contactSourceBinding } from "./internal/outbound-contact-source-context.ts";
import type { OutboundContactSourceConfig, OutboundContactSourceSelection } from "./internal/outbound-contact-source-context.ts";
import { NativeOutboundRecords } from "./internal/outbound-native-record.ts";
import type { NativeOutboundFailure } from "./internal/outbound-native-record.ts";
import type { PatientRecallRow } from "./internal/patient-recall-history.ts";
import { readPatientRecallHistory, PatientRecallHistoryError } from "./internal/patient-recall-history.ts";
import { encodeOutboundContactReview, decodeOutboundContactReview, outboundContactReviewDigest } from "./outbound-contact-review.ts";
import type { OutboundContactReview } from "./outbound-contact-review.ts";
import { evaluateOutboundContactHistory } from "./outbound-contact-lineage.ts";
import { encodeOutboundRecipientRequest, decodeOutboundRecipientRequest, outboundRecipientRequestDigest } from "./outbound-recipient-request.ts";
import type { OutboundRecipientRequest } from "./outbound-recipient-request.ts";
export type { OutboundContactSourceConfig, OutboundContactSourceSelection } from "./internal/outbound-contact-source-context.ts";
export { contactSourceSelection } from "./internal/outbound-contact-source-context.ts";

type QueryBase = OutboundContactSourceSelection & Readonly<{ ownerBinding: string; patientId: string }>;
export type OutboundContactQuery = QueryBase & (
  Readonly<{ operation: "readPatientContact" }> |
  Readonly<{ operation: "readContactHistory"; includeArchived: true; includeClosed: true }> |
  Readonly<{ operation: "readContactReview"; includeArchived: true; recallRef: string; actionRef: string; review?: OutboundContactReview; reviewDigest?: string }> |
  Readonly<{ operation: "approveContactHead"; recallRef: string; review: OutboundContactReview; reviewDigest: string }> |
  Readonly<{ operation: "approveContactReconsent"; recallRef: string; review: OutboundContactReview; reviewDigest: string; approvalRef: string }>
);
export type OutboundContactAuthority = Readonly<{
  /** Each operation is independently granted; content and old approval IDs are
   * not evidence that the current read/head/reconsent grant was given. */
  allows(query: OutboundContactQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundContactQuery, signal: AbortSignal): boolean;
}>;
export type OutboundContactDefinition = Readonly<{
  currentFor(selection: OutboundContactSourceSelection, signal: AbortSignal): Promise<Result<boolean, Readonly<{ kind: "unavailable" }>>>;
}>;
export type OutboundContactEvidence = Readonly<{ kind: "contactReviewEvidence"; disposition: "eligibleEvidence" | "blocked";
  observedAt: string; requestDigest: string; head?: Readonly<{ recallRef: string; review: OutboundContactReview; digest: string }> }>;
type Row = Record<string, unknown>;
const object = (v: unknown): Row | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
class Failure extends Error {
  readonly kind: NativeOutboundFailure["kind"];
  readonly resetAt?: string;
  readonly retryAfterMs?: number;
  constructor(kind: NativeOutboundFailure["kind"]) { super("Contact review evidence unavailable"); this.kind = kind; }
}
function discard(response: Response | undefined): void { try { void response?.body?.cancel().catch(() => {}); } catch { /* Owned body only. */ } }

/** Concrete private native observation, never a promise of future contact
 * eligibility. No producer/journal/write/launch capability is held. Whole history
 * includes archived/closed decisions; exact rereads and a repeated complete scan
 * detect changes without claiming an atomic snapshot. */
export class ClinikoOutboundContactSource {
  readonly #config: OutboundContactSourceConfig;
  readonly #selection: OutboundContactSourceSelection;
  readonly #definition: OutboundContactDefinition;
  readonly #authority: OutboundContactAuthority;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #owner: string;
  private constructor(config: OutboundContactSourceConfig, definition: OutboundContactDefinition, authority: OutboundContactAuthority, port: typeof fetch, shard: string) {
    this.#selection = contactSourceSelection(config); this.#owner = contactSourceBinding(this.#selection);
    this.#config = Object.freeze({ ...config, scope: this.#selection.scope,
      rateBudget: Object.freeze({ claim: config.rateBudget.claim.bind(config.rateBudget), observe429: config.rateBudget.observe429.bind(config.rateBudget) }),
      contactRevision: Object.freeze({ matches: config.contactRevision.matches.bind(config.contactRevision), read: config.contactRevision.read.bind(config.contactRevision) }),
      ...(config.clock ? { clock: config.clock.bind(config) } : {}) });
    this.#definition = Object.freeze({ currentFor: definition.currentFor.bind(definition) });
    this.#authority = Object.freeze({ allows: authority.allows.bind(authority), current: authority.current.bind(authority) });
    this.#fetch = port; this.#base = `https://api.${shard}.cliniko.com/v1`;
  }
  static create(config: OutboundContactSourceConfig, definition: OutboundContactDefinition, authority: OutboundContactAuthority, port: typeof fetch = fetch): Result<ClinikoOutboundContactSource, NativeOutboundFailure> {
    try {
      const shard = contactSourceShard(config, port);
      if (!shard || typeof definition?.currentFor !== "function" || typeof authority?.allows !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundContactSource(config, definition, authority, port, shard));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async readCurrentForRequest(input: OutboundRecipientRequest, external: AbortSignal): Promise<Result<OutboundContactEvidence, NativeOutboundFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    const encoded = encodeOutboundRecipientRequest(input); if (!encoded.ok) return err({ kind: "invalidQuery" });
    const decoded = decodeOutboundRecipientRequest(encoded.value); if (!decoded.ok) return err({ kind: "invalidQuery" });
    const request = decoded.value, s = this.#selection;
    if (request.scope.tenantId !== s.scope.tenantId || request.scope.clinicId !== s.scope.clinicId || request.scope.locationId !== s.scope.locationId ||
      request.businessId !== s.businessId || request.credentialFingerprint !== s.credentialFingerprint) return err({ kind: "invalidQuery" });
    const ms = this.#config.deadlineMs ?? 15000, deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), ms), began = performance.now();
    const signal = AbortSignal.any([external, deadline.signal]); let lastAt: string | undefined;
    const active = () => !signal.aborted && performance.now() - began <= ms;
    const clock = () => {
      const raw = this.#config.clock?.() ?? new Date().toISOString(), at = outboundNativeInstant(raw);
      if (!at || at !== raw || lastAt !== undefined && at < lastAt || !active()) throw new Failure("unavailable"); lastAt = at; return at;
    };
    const wait = async <T>(task: Promise<T>): Promise<T> => {
      const found = await awaitUntilAbort(task, signal); if (found === undefined || !active()) throw new Failure("unavailable"); clock(); return found;
    };
    const base = Object.freeze({ ...s, ownerBinding: this.#owner, patientId: request.patientId });
    const patient: OutboundContactQuery = Object.freeze({ ...base, operation: "readPatientContact" });
    const collection: OutboundContactQuery = Object.freeze({ ...base, operation: "readContactHistory", includeArchived: true, includeClosed: true });
    const grants = new Map<string, OutboundContactQuery>();
    const current = (q: OutboundContactQuery) => { if (!active() || this.#authority.current(q, signal) !== true || !active()) throw new Failure("forbidden"); };
    const definition = async () => {
      const found = await wait(this.#definition.currentFor(s, signal)); if (!found.ok) throw new Failure("unavailable"); if (!found.value) throw new Failure("forbidden");
    };
    const permit = async (q: OutboundContactQuery) => {
      await definition(); current(q);
      if (await wait(Promise.resolve().then(() => this.#authority.allows(q, signal))) !== true) throw new Failure("forbidden");
      await definition(); current(q); grants.set(JSON.stringify(q), q);
    };
    const get = async (url: string, q: OutboundContactQuery) => {
      await permit(q); const limited = await wait(claimClinikoBudget(this.#config.rateBudget));
      if (limited) throw Object.assign(new Failure(limited.kind), limited); await permit(q);
      let response: Response | undefined, bodyOwned = false;
      try {
        clock(); current(q);
        response = await wait(this.#fetch(url, { method: "GET", redirect: "error", signal, headers: { Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${this.#config.apiKey}:`).toString("base64")}`, "User-Agent": `Abby (${this.#config.contactEmail})` } }).then(r => {
          response = r; if (signal.aborted) discard(r); return r;
        }));
        if (response.status === 429) throw Object.assign(new Failure("rateLimited"), await wait(observeCliniko429(this.#config.rateBudget, response.headers.get("X-RateLimit-Reset"))));
        if ([401, 403].includes(response.status)) throw new Failure("forbidden"); if (response.status !== 200) throw new Failure("unavailable");
        bodyOwned = true; const bytes = await wait(ownedBodyBytes(response.body, 1_000_000, signal));
        let value: unknown; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Failure("malformed"); }
        await permit(q); return value;
      } finally { if (!bodyOwned) discard(response); }
    };
    const revision = async () => {
      await permit(patient);
      if (!this.#config.contactRevision.matches(s.scope.tenantId, s.credentialFingerprint)) throw new Failure("forbidden");
      const found = await wait(this.#config.contactRevision.read(s.credentialFingerprint));
      if (!found.ok || found.value.blocked || !Number.isSafeInteger(found.value.version) || found.value.version < 0) throw new Failure("unavailable");
      await permit(patient); return found.value.version;
    };
    const phone = async () => {
      const raw = object(await get(`${this.#base}/patients/${request.patientId}`, patient));
      const updatedAt = outboundNativeInstant(raw?.updated_at), link = object(raw?.links)?.self;
      if (!raw || raw.id !== request.patientId || raw.archived_at !== null || link !== `${this.#base}/patients/${request.patientId}` ||
        !updatedAt || Date.parse(updatedAt) > Date.parse(clock()) + 30000 || !Array.isArray(raw.patient_phone_numbers) || raw.patient_phone_numbers.length > 20) throw new Failure("malformed");
      const numbers: string[] = [];
      for (const item of raw.patient_phone_numbers) {
        const row = object(item);
        if (!row || row.number !== null && typeof row.number !== "string" || row.phone_type !== null && row.phone_type !== undefined && typeof row.phone_type !== "string") throw new Failure("malformed");
        if (String(row.phone_type).toLowerCase() === "fax" || row.number === null) continue;
        const normalized = normalizePatientPhone(row.number as string, s.countryCallingCode); if (!normalized) throw new Failure("malformed"); numbers.push(normalized);
      }
      return Object.freeze({ key: JSON.stringify([updatedAt, [...numbers].sort()]), matches: numbers.includes(request.recipient.number) });
    };
    try {
      clock(); await definition();
      const initialRevision = await revision(), firstPhone = await phone();
      const scan = () => readPatientRecallHistory({ base: this.#base, patientId: request.patientId, typeId: s.contactReviewRecallTypeId }, url => get(url, collection), clock);
      const history = await scan(), reviews: OutboundContactReview[] = [], nativeRows = new Map<string, PatientRecallRow>();
      const native = new NativeOutboundRecords<OutboundContactReview, OutboundContactQuery>({ ...this.#config, credentialFingerprint: s.credentialFingerprint,
        typeId: s.contactReviewRecallTypeId }, this.#base.split(".")[1]!, this.#owner, {
        allows: async q => { try { await permit(collection); await permit(q); return true; } catch (error) { if (error instanceof Failure && error.kind === "forbidden") return false; throw error; } },
        current: q => { try { current(collection); current(q); return true; } catch { return false; } },
      }, this.#fetch, { encode: encodeOutboundContactReview, decode: decodeOutboundContactReview, recordedAt: r => r.reviewedAt, expiresAt: r => r.effectiveUntil },
      q => Object.freeze({ ...base, operation: "readContactReview", includeArchived: true, recallRef: q.recallRef!, actionRef: q.actionRef,
        ...(q.record ? { review: q.record, reviewDigest: outboundContactReviewDigest(q.record)! } : {}) }));
      for (const row of history.rows) {
        const parsed = decodeOutboundContactReview(row.notes); if (!parsed.ok) throw new Failure("malformed");
        const review = parsed.value;
        if (nativeRows.has(review.actionRef)) throw new Failure("mismatched"); nativeRows.set(review.actionRef, row);
        if (review.contactRecallTypeId !== s.contactReviewRecallTypeId || review.policy.version !== s.contactPolicyVersion || review.policy.digest !== s.contactPolicyDigest) throw new Failure("mismatched");
        const found = await wait(native.read({ recallRef: `cliniko:recall:${row.id}`, actionRef: review.actionRef, patientId: request.patientId }, signal));
        if (!found.ok) return found;
        const r = found.value;
        if (r.createdAt !== row.createdAt || r.updatedAt !== row.updatedAt || r.recalled !== row.recalled || r.recalledAt !== row.recalledAt ||
          r.archivedAt !== row.archivedAt || r.recallAt !== row.recallAt || outboundContactReviewDigest(r.record) !== outboundContactReviewDigest(review)) throw new Failure("mismatched");
        reviews.push(r.record);
      }
      const successors = new Set(reviews.flatMap(r => r.predecessor ? [r.predecessor.actionRef] : [])), heads = reviews.filter(r => !successors.has(r.actionRef));
      if (heads.length > 1 || reviews.length && heads.length !== 1) throw new Failure("mismatched");
      const head = heads[0], row = head ? nativeRows.get(head.actionRef) : undefined;
      let headEvidence: OutboundContactEvidence["head"], disposition: OutboundContactEvidence["disposition"] = "blocked";
      if (head) {
        if (!row) throw new Failure("mismatched"); const digest = outboundContactReviewDigest(head)!;
        const lineage = evaluateOutboundContactHistory(reviews, { actionRef: head.actionRef, digest }, clock()); if (!lineage.ok) throw new Failure("mismatched");
        const recallRef = `cliniko:recall:${row.id}`;
        await permit(Object.freeze({ ...base, operation: "approveContactHead", recallRef, review: head, reviewDigest: digest }));
        for (const review of reviews) if (review.reconsentApprovalRef) {
          const linked = nativeRows.get(review.actionRef); if (!linked) throw new Failure("mismatched");
          await permit(Object.freeze({ ...base, operation: "approveContactReconsent", recallRef: `cliniko:recall:${linked.id}`, review,
            reviewDigest: outboundContactReviewDigest(review)!, approvalRef: review.reconsentApprovalRef }));
        }
        headEvidence = Object.freeze({ recallRef, review: head, digest });
        if (lineage.value.disposition === "eligibleEvidence" && !row.recalled && row.archivedAt === null && firstPhone.matches &&
          head.recipient.number === request.recipient.number && head.purposes.includes(request.purpose)) disposition = "eligibleEvidence";
      }
      for (const q of [...grants.values()]) await permit(q);
      if (JSON.stringify(await scan()) !== JSON.stringify(history)) throw new Failure("mismatched");
      if ((await phone()).key !== firstPhone.key || await revision() !== initialRevision) throw new Failure("mismatched");
      await definition(); for (const q of grants.values()) current(q);
      const at = clock();
      if (head && (at < head.effectiveFrom || at >= head.effectiveUntil)) disposition = "blocked";
      return ok(Object.freeze({ kind: "contactReviewEvidence", disposition, observedAt: at, requestDigest: outboundRecipientRequestDigest(request)!, ...(headEvidence ? { head: headEvidence } : {}) }));
    } catch (error) {
      return err({ kind: error instanceof Failure || error instanceof OwnedBodyError || error instanceof PatientRecallHistoryError ? error.kind : "unavailable",
        ...(error instanceof Failure && error.resetAt ? { resetAt: error.resetAt } : {}),
        ...(error instanceof Failure && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) });
    } finally { clearTimeout(timer); deadline.abort(); }
  }
}
