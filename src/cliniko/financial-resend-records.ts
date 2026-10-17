import { encodeFinancialResendAttempt, decodeFinancialResendAttempt, resendAttemptMatchesRequest } from "./financial-resend-attempt.ts";
import type { FinancialResendAttempt } from "./financial-resend-attempt.ts";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { FinancialEffectBarrier } from "../standalone/financial-effect-barrier.ts";
import { FinancialRecordTransport } from "./internal/financial-record-transport.ts";
import type { FinancialRecordQuery } from "./internal/financial-record-transport.ts";
import { financialConfigShard, financialSelection } from "./internal/financial-record-context.ts";
import type { ClinikoFinancialReviewSelection } from "./internal/financial-record-context.ts";
import { financialIntentDigest } from "./financial-booking-observation.ts";
import { financialRecordOwnerBinding } from "./financial-record-retention.ts";
import type { FinancialRecordRetentionConfig, FinancialRecordAuthority, FinancialRecordFailure, FinancialRecordRetention } from "./financial-record-retention.ts";
import { encodeClinikoFinancialIntent, decodeClinikoFinancialIntent } from "./financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { encodeFinancialResendRequest, decodeFinancialResendRequest, resendRequestMatchesIntent } from "./financial-resend-request.ts";
import type { FinancialResendRequest } from "./financial-resend-request.ts";
import { validRecallDate, validRecallMarker } from "./recall-note.ts";

type Binding = Readonly<{ recallRef: string; actionRef: string; intentRecallRef: string }>;
export type FinancialResendContext = Readonly<{ kind: "resendRequestContext"; recallRef: string; recalled: boolean;
  archivedAt: string | null; request: FinancialResendRequest }>;
type AttemptSource = Readonly<{ intent: ClinikoFinancialIntent; requestRecallRef: string; request: FinancialResendRequest }>;
export type FinancialResendAttemptContext = Readonly<{ kind: "resendAttemptContext"; recallRef: string; recalled: boolean;
  archivedAt: string | null; attempt: FinancialResendAttempt }>;
const invalid = () => err({ kind: "invalidQuery" as const });
const recallId = (v: unknown) => typeof v === "string" ? /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(v)?.[1] : undefined;

/** Dedicated native prospective-request family. Retention consumes only its
 * opaque record action. It never consumes an old send effect, sends a message
 * or supplies independent current resend/recipient/producer permission. */
export class ClinikoFinancialResendRecords {
  readonly #native: FinancialRecordTransport;
  readonly #selection: ClinikoFinancialReviewSelection;
  readonly #binding: string;
  readonly #canWrite: boolean;
  private constructor(native: FinancialRecordTransport, selection: ClinikoFinancialReviewSelection, binding: string, canWrite = true) {
    this.#native = native; this.#selection = selection; this.#binding = binding; this.#canWrite = canWrite;
  }
  static create(config: FinancialRecordRetentionConfig, authority: FinancialRecordAuthority, barrier: FinancialEffectBarrier,
    native: typeof fetch = fetch): Result<ClinikoFinancialResendRecords, FinancialRecordFailure> {
    try {
      const shard = financialConfigShard(config, native), binding = financialRecordOwnerBinding(config);
      if (!shard || !binding.ok || [authority?.allows, authority?.producerAdmitted, authority?.current, barrier?.matches, barrier?.claimOnce].some(f => typeof f !== "function") ||
          barrier.matches(financialSelection(config).scope, binding.value) !== true) return err({ kind: "invalidConfig" });
      const transport = new FinancialRecordTransport(config, shard, authority, barrier, native);
      return ok(new ClinikoFinancialResendRecords(transport, transport.selection(), binding.value));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  /** Discovery-only read capability. No journal or producer admission is minted;
   * even a dynamically accessed retain method refuses before any native I/O. */
  static createReadOnly(config: FinancialRecordRetentionConfig, authority: Pick<FinancialRecordAuthority, "allows" | "current">,
    native: typeof fetch = fetch): Result<Pick<ClinikoFinancialResendRecords, "readRequest" | "readAttempt">, FinancialRecordFailure> {
    try {
      const shard = financialConfigShard(config, native), binding = financialRecordOwnerBinding(config);
      if (!shard || !binding.ok || typeof authority?.allows !== "function" || typeof authority.current !== "function") return err({ kind: "invalidConfig" });
      const unavailable: FinancialEffectBarrier = { matches: () => false, claimOnce: async () => err({ kind: "storageFailure" }) };
      const transport = new FinancialRecordTransport(config, shard, { allows: authority.allows.bind(authority), current: authority.current.bind(authority), producerAdmitted: async () => false }, unavailable, native);
      return ok(new ClinikoFinancialResendRecords(transport, transport.selection(), binding.value, false));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  #intent(input: ClinikoFinancialIntent): ClinikoFinancialIntent | undefined {
    const encoded = encodeClinikoFinancialIntent(input); if (!encoded.ok) return undefined;
    const decoded = decodeClinikoFinancialIntent(encoded.value); if (!decoded.ok) return undefined;
    const i = decoded.value, s = this.#selection;
    return i.scope.tenantId === s.scope.tenantId && i.scope.clinicId === s.scope.clinicId && i.scope.locationId === s.scope.locationId &&
      i.businessId === s.businessId && i.credentialFingerprint === s.credentialFingerprint &&
      i.stripe.accountRef === s.stripe.accountRef && i.stripe.livemode === s.stripe.livemode ? i : undefined;
  }
  #query(i: ClinikoFinancialIntent, actionRef: string, operation: FinancialRecordQuery["operation"],
    refs: Readonly<{ recallRef?: string; intentRecallRef: string; recallAt?: string; resendRequest?: FinancialResendRequest; resendAttempt?: FinancialResendAttempt }>): FinancialRecordQuery {
    return Object.freeze({ ...this.#selection, ownerBinding: this.#binding, operation, actionRef,
      financialActionRef: i.actionRef, patientId: i.patientId, intentDigest: financialIntentDigest(i)!, ...refs });
  }
  async retainRequestOnce(input: FinancialResendRequest, expected: ClinikoFinancialIntent, recallAt: string,
    signal: AbortSignal): Promise<Result<FinancialRecordRetention, FinancialRecordFailure>> {
    try {
      if (!this.#canWrite) return err({ kind: "forbidden" });
      const intent = this.#intent(expected), encoded = encodeFinancialResendRequest(input);
      if (!intent || !encoded.ok || !validRecallDate(recallAt)) return invalid();
      const decoded = decodeFinancialResendRequest(encoded.value); if (!decoded.ok) return invalid(); const request = decoded.value;
      if (!resendRequestMatchesIntent(request, intent, request.intentRecallRef)) return invalid();
      const result = await this.#native.request({ method: "POST", notes: encoded.value, recallAt,
        notBefore: new Date(Date.parse(request.requestedAt) - 30_000).toISOString(), notAfter: request.expiresAt,
        query: this.#query(intent, request.actionRef, "retainResendRequest", { intentRecallRef: request.intentRecallRef, recallAt, resendRequest: request }) }, signal);
      if (!result.ok) return result;
      if (result.value.kind === "uncertain" || [request.intentRecallRef, request.observationRecallRef, request.checkoutAttemptRecallRef].includes(result.value.recallRef)) return ok({ kind: "uncertain" });
      return ok({ kind: "accepted", recallRef: result.value.recallRef, actionRef: request.actionRef });
    } catch { return invalid(); }
  }
  async readRequest(input: Binding, expected: ClinikoFinancialIntent, signal: AbortSignal): Promise<Result<FinancialResendContext, FinancialRecordFailure>> {
    try {
      const binding = Object.freeze({ ...input }), intent = this.#intent(expected), id = recallId(binding.recallRef);
      if (!intent || !id || !validRecallMarker(binding.actionRef) || !recallId(binding.intentRecallRef) || binding.recallRef === binding.intentRecallRef) return invalid();
      const result = await this.#native.request({ method: "GET", recallId: id,
        query: this.#query(intent, binding.actionRef, "readResendRequest", { recallRef: binding.recallRef, intentRecallRef: binding.intentRecallRef }) }, signal);
      if (!result.ok) return result; if (result.value.kind !== "record") return err({ kind: "unavailable" });
      const decoded = decodeFinancialResendRequest(result.value.notes), row = result.value;
      if (!decoded.ok || decoded.value.actionRef !== binding.actionRef || !resendRequestMatchesIntent(decoded.value, intent, binding.intentRecallRef) ||
          [decoded.value.intentRecallRef, decoded.value.observationRecallRef, decoded.value.checkoutAttemptRecallRef].includes(row.recallRef) ||
          Date.parse(row.createdAt) < Date.parse(decoded.value.requestedAt) - 30_000 || row.createdAt >= decoded.value.expiresAt) return err({ kind: "mismatched" });
      return ok({ kind: "resendRequestContext", recallRef: row.recallRef, recalled: row.recalled, archivedAt: row.archivedAt, request: decoded.value });
    } catch { return invalid(); }
  }
  /** Possible-send context must be acknowledged before the separately approved
   * sender is invoked. This method itself grants no message permission. */
  async retainAttemptOnce(input: FinancialResendAttempt, source: AttemptSource, recallAt: string,
    signal: AbortSignal): Promise<Result<FinancialRecordRetention, FinancialRecordFailure>> {
    try {
      if (!this.#canWrite) return err({ kind: "forbidden" });
      const intent = this.#intent(source.intent), requestRef = source.requestRecallRef;
      const encodedRequest = encodeFinancialResendRequest(source.request), encoded = encodeFinancialResendAttempt(input);
      if (!intent || !encoded.ok || !encodedRequest.ok || !validRecallDate(recallAt)) return invalid();
      const r = decodeFinancialResendRequest(encodedRequest.value), a = decodeFinancialResendAttempt(encoded.value);
      if (!r.ok || !a.ok || !resendAttemptMatchesRequest(a.value, r.value, requestRef, intent)) return invalid();
      const request = r.value, attempt = a.value;
      const latest = new Date(Date.parse(attempt.attemptedAt) + 60_000).toISOString();
      const result = await this.#native.request({ method: "POST", notes: encoded.value, recallAt,
        notBefore: new Date(Date.parse(attempt.attemptedAt) - 30_000).toISOString(), notAfter: latest < request.expiresAt ? latest : request.expiresAt,
        query: this.#query(intent, attempt.actionRef, "retainResendAttempt", { intentRecallRef: attempt.intentRecallRef,
          recallAt, resendRequest: request, resendAttempt: attempt }) }, signal);
      if (!result.ok) return result;
      if (result.value.kind === "uncertain" || [requestRef, request.intentRecallRef, request.observationRecallRef, request.checkoutAttemptRecallRef].includes(result.value.recallRef)) return ok({ kind: "uncertain" });
      return ok({ kind: "accepted", recallRef: result.value.recallRef, actionRef: attempt.actionRef });
    } catch { return invalid(); }
  }
  async readAttempt(input: Binding, source: AttemptSource, signal: AbortSignal): Promise<Result<FinancialResendAttemptContext, FinancialRecordFailure>> {
    try {
      const binding = Object.freeze({ ...input }), intent = this.#intent(source.intent), requestRef = source.requestRecallRef;
      const encoded = encodeFinancialResendRequest(source.request); if (!intent || !encoded.ok) return invalid();
      const decoded = decodeFinancialResendRequest(encoded.value), id = recallId(binding.recallRef);
      if (!decoded.ok || !id || !validRecallMarker(binding.actionRef) || binding.intentRecallRef !== decoded.value.intentRecallRef ||
          !recallId(requestRef) || [requestRef, decoded.value.intentRecallRef, decoded.value.observationRecallRef, decoded.value.checkoutAttemptRecallRef].includes(binding.recallRef)) return invalid();
      const request = decoded.value;
      const result = await this.#native.request({ method: "GET", recallId: id,
        query: this.#query(intent, binding.actionRef, "readResendAttempt", { recallRef: binding.recallRef, intentRecallRef: binding.intentRecallRef, resendRequest: request }) }, signal);
      if (!result.ok) return result; if (result.value.kind !== "record") return err({ kind: "unavailable" });
      const attempt = decodeFinancialResendAttempt(result.value.notes);
      if (!attempt.ok || attempt.value.actionRef !== binding.actionRef || !resendAttemptMatchesRequest(attempt.value, request, requestRef, intent)) return err({ kind: "mismatched" });
      return ok({ kind: "resendAttemptContext", recallRef: result.value.recallRef, recalled: result.value.recalled, archivedAt: result.value.archivedAt, attempt: attempt.value });
    } catch { return invalid(); }
  }

}
