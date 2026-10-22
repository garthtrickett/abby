import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { awaitUntilAbort } from "../shared/await-until-abort.ts";
import { OwnedBodyError } from "../shared/owned-body-bytes.ts";
import { outboundConfigShard, outboundNativeInstant } from "./internal/outbound-record-context.ts";
import { readNativeOutboundAccountHistory, NativeOutboundHistoryReadError } from "./internal/outbound-account-history.ts";
import { PatientRecallHistoryError } from "./internal/patient-recall-history.ts";
import type { NativeOutboundContext, NativeOutboundFailure } from "./internal/outbound-native-record.ts";
import { encodeOutboundLaunchAttempt, decodeOutboundLaunchAttempt } from "./outbound-launch-attempt.ts";
import type { OutboundLaunchRecord } from "./outbound-launch-records.ts";
import { decodeOutboundStaffReviewRequest, outboundStaffReviewActionRef, outboundStaffReviewMatchesAttempt } from "./outbound-staff-review-request.ts";
import type { OutboundStaffReviewRequest } from "./outbound-staff-review-request.ts";
import { ClinikoOutboundStaffReviewRecords, outboundStaffReviewRecordBinding, outboundStaffReviewSelection } from "./outbound-staff-review-records.ts";
import type { OutboundStaffReviewConfig, OutboundStaffReviewQuery, OutboundStaffReviewSelection } from "./outbound-staff-review-records.ts";

export type OutboundStaffReviewHistoryQuery = OutboundStaffReviewSelection & Readonly<{
  ownerBinding: string; operation: "readStaffReviewHistory"; original: OutboundLaunchRecord; includeArchived: true; includeClosed: true;
}>;
export type OutboundStaffReviewHistoryAuthority = Readonly<{
  allowsHistoryRead(query: OutboundStaffReviewHistoryQuery, signal: AbortSignal): Promise<boolean>;
  allowsRecordRead(query: OutboundStaffReviewQuery, signal: AbortSignal): Promise<boolean>;
  current(query: OutboundStaffReviewHistoryQuery | OutboundStaffReviewQuery, signal: AbortSignal): boolean;
}>;
class Refusal extends Error {
  readonly kind: NativeOutboundFailure["kind"];
  constructor(kind: NativeOutboundFailure["kind"]) { super("Native staff review unavailable"); this.kind = kind; }
}
/** Complete bounded native history plus exact protected rereads. An absent,
 * edited or ambiguous request never resets its permanent purpose. Source and
 * notification authentication remain with the separately authorized producer. */
export class ClinikoOutboundStaffReviewHistory {
  readonly #config: OutboundStaffReviewConfig;
  readonly #authority: OutboundStaffReviewHistoryAuthority;
  readonly #owner: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  private constructor(c: OutboundStaffReviewConfig, a: OutboundStaffReviewHistoryAuthority, owner: string, shard: string, port: typeof fetch) {
    this.#config = Object.freeze({ ...c, scope: Object.freeze({ ...c.scope }), ...(c.clock ? { clock: c.clock.bind(c) } : {}),
      rateBudget: Object.freeze({ claim: c.rateBudget.claim.bind(c.rateBudget), observe429: c.rateBudget.observe429.bind(c.rateBudget) }) });
    this.#authority = Object.freeze({ allowsHistoryRead: a.allowsHistoryRead.bind(a), allowsRecordRead: a.allowsRecordRead.bind(a), current: a.current.bind(a) });
    this.#owner = owner; this.#base = `https://api.${shard}.cliniko.com/v1`; this.#fetch = port;
  }
  static create(c: OutboundStaffReviewConfig, a: OutboundStaffReviewHistoryAuthority, port: typeof fetch = fetch): Result<ClinikoOutboundStaffReviewHistory, NativeOutboundFailure> {
    try {
      const shard = outboundConfigShard({ ...c, outboundRecallTypeId: c.outboundStaffReviewRecallTypeId, recordPolicyDigest: c.staffReviewPolicyDigest }, port), owner = outboundStaffReviewRecordBinding(c);
      if (!shard || !owner || [a?.allowsHistoryRead, a?.allowsRecordRead, a?.current].some(f => typeof f !== "function")) return err({ kind: "invalidConfig" });
      return ok(new ClinikoOutboundStaffReviewHistory(c, a, owner, shard, port));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async findForAttempt(input: OutboundLaunchRecord, external: AbortSignal): Promise<Result<Readonly<{
    kind: "nativeStaffReviewHistory"; selected: number; scanned: number; record?: NativeOutboundContext<OutboundStaffReviewRequest>;
  }>, NativeOutboundFailure>> {
    if (!(external instanceof AbortSignal) || external.aborted) return err({ kind: "unavailable" });
    let original: OutboundLaunchRecord;
    try {
      const raw = structuredClone(input), encoded = encodeOutboundLaunchAttempt(raw.attempt);
      if (!encoded.ok || raw.kind !== "possibleLaunchContext" || Object.keys(raw).sort().join(",") !== "archivedAt,attempt,createdAt,kind,recallAt,recallRef,recalled,recalledAt,updatedAt" ||
          !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(raw.recallRef)) return err({ kind: "invalidQuery" });
      const decoded = decodeOutboundLaunchAttempt(encoded.value); if (!decoded.ok) return err({ kind: "invalidQuery" });
      const s = outboundStaffReviewSelection(this.#config), a = decoded.value;
      if (!isDeepStrictEqual(a.scope, s.scope) || a.businessId !== s.businessId || a.credentialFingerprint !== s.credentialFingerprint) return err({ kind: "invalidQuery" });
      original = Object.freeze({ ...raw, attempt: decoded.value });
    } catch { return err({ kind: "invalidQuery" }); }
    const c = this.#config, controller = new AbortController(), ms = c.deadlineMs ?? 15000;
    const timer = setTimeout(() => controller.abort(), ms), signal = AbortSignal.any([external, controller.signal]), began = performance.now();
    const q: OutboundStaffReviewHistoryQuery = Object.freeze({ ...outboundStaffReviewSelection(c), ownerBinding: this.#owner, operation: "readStaffReviewHistory",
      original, includeArchived: true, includeClosed: true });
    const grants = new Map<string, OutboundStaffReviewQuery>(); let last = "", claims = 0;
    const now = () => {
      const at = c.clock?.() ?? new Date().toISOString();
      if (signal.aborted || performance.now() - began > ms || outboundNativeInstant(at) !== at || at < last) throw new Refusal("unavailable");
      last = at; return at;
    };
    const wait = async <T>(task: Promise<T>): Promise<T> => { const v = await awaitUntilAbort(task, signal); if (v === undefined) throw new Refusal("unavailable"); now(); return v; };
    const current = () => {
      now(); if (this.#authority.current(q, signal) !== true || [...grants.values()].some(g => this.#authority.current(g, signal) !== true)) throw new Refusal("forbidden"); now();
    };
    const permit = async () => { current(); if (await wait(this.#authority.allowsHistoryRead(q, signal)) !== true) throw new Refusal("forbidden"); current(); };
    const budget = Object.freeze({ claim: () => ++claims <= 180 ? c.rateBudget.claim() : { kind: "unavailable" as const }, observe429: c.rateBudget.observe429 });
    try {
      now();
      const scan = () => readNativeOutboundAccountHistory({ base: this.#base, typeIds: [c.outboundStaffReviewRecallTypeId], apiKey: c.apiKey,
        contactEmail: c.contactEmail, rateBudget: budget }, { signal, now, current, permit, wait }, this.#fetch);
      const history = await scan(), purposes = new Set<string>(), origins = new Set<string>();
      const reader = ClinikoOutboundStaffReviewRecords.createReadOnly({ ...c, rateBudget: budget }, {
        allows: async (g, s) => {
          await permit(); if (this.#authority.current(g, s) !== true || await wait(this.#authority.allowsRecordRead(g, s)) !== true) return false;
          grants.set(g.recallRef! + ":" + (g.requestDigest ?? "binding"), g); current(); return this.#authority.current(g, s) === true;
        }, current: (g, s) => { try { current(); return this.#authority.current(g, s) === true; } catch { return false; } }
      }, this.#fetch);
      if (!reader.ok) return reader;
      let result: NativeOutboundContext<OutboundStaffReviewRequest> | undefined;
      for (const row of history.rows) {
        const decoded = decodeOutboundStaffReviewRequest(row.notes); if (!decoded.ok) throw new Refusal("malformed"); const request = decoded.value;
        if (purposes.has(request.actionRef) || origins.has(request.attempt.recallRef)) throw new Refusal("mismatched");
        purposes.add(request.actionRef); origins.add(request.attempt.recallRef);
        const found = await wait(reader.value.readRequest({ recallRef: `cliniko:recall:${row.id}`, actionRef: request.actionRef, patientId: row.patientId }, signal));
        if (!found.ok) return found;
        const { id, typeId: _typeId, notes: _notes, patientId: _patientId, ...metadata } = row;
        if (!isDeepStrictEqual(found.value, { kind: "nativeOutboundContext", recallRef: `cliniko:recall:${id}`, record: request, ...metadata })) throw new Refusal("mismatched");
        if (request.actionRef === outboundStaffReviewActionRef(original.attempt.actionRef) || request.attempt.actionRef === original.attempt.actionRef || request.attempt.recallRef === original.recallRef) {
          if (result || !outboundStaffReviewMatchesAttempt(request, original)) throw new Refusal("mismatched"); result = found.value;
        }
      }
      await permit(); if (!isDeepStrictEqual(await scan(), history)) throw new Refusal("mismatched"); await permit(); current();
      return ok(Object.freeze({ kind: "nativeStaffReviewHistory", selected: history.rows.length, scanned: history.scanned, ...(result ? { record: result } : {}) }));
    } catch (e) {
      return err({ kind: e instanceof Refusal || e instanceof NativeOutboundHistoryReadError || e instanceof PatientRecallHistoryError || e instanceof OwnedBodyError ? e.kind : "unavailable" });
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
