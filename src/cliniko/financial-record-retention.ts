import { createHash, KeyObject } from "node:crypto";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import type { FinancialEffectBarrier } from "../standalone/financial-effect-barrier.ts";
import { encodeFinancialCheckoutAttempt, decodeFinancialCheckoutAttempt, checkoutAttemptMatchesIntent } from "./financial-checkout-attempt.ts";
import type { FinancialCheckoutAttempt } from "./financial-checkout-attempt.ts";
import { encodeFinancialMessageAttempt, decodeFinancialMessageAttempt, messageAttemptMatchesIntent } from "./financial-message-attempt.ts";
import type { FinancialMessageAttempt } from "./financial-message-attempt.ts";
import { encodeFinancialExpiryAttempt, decodeFinancialExpiryAttempt, expiryAttemptMatchesIntent } from "./financial-expiry-attempt.ts";
import type { FinancialExpiryAttempt } from "./financial-expiry-attempt.ts";
import { decodeClinikoFinancialIntent, encodeClinikoFinancialIntent } from "./financial-review-intent.ts";
import type { ClinikoFinancialIntent } from "./financial-review-intent.ts";
import { financialIntentDigest, verifyFinancialBookingObservation } from "./financial-booking-observation.ts";
import type { ClinikoFinancialBookingObservation } from "./financial-booking-observation.ts";
import { validRecallDate, validRecallMarker } from "./recall-note.ts";
import { financialConfigShard, financialSelection } from "./internal/financial-record-context.ts";
import type { ClinikoFinancialReviewConfig, ClinikoFinancialReviewSelection } from "./internal/financial-record-context.ts";
import { FinancialRecordTransport } from "./internal/financial-record-transport.ts";
import type { FinancialRecordAuthority, FinancialRecordFailure, FinancialRecordQuery } from "./internal/financial-record-transport.ts";
export type { FinancialRecordAuthority, FinancialRecordFailure, FinancialRecordQuery } from "./internal/financial-record-transport.ts";

export type FinancialRecordRetentionConfig = ClinikoFinancialReviewConfig & Readonly<{
  producer: Readonly<{ keyRef: string; publicKey: KeyObject }>;
}>;
export type FinancialRecordRetention = Readonly<{ kind: "accepted"; recallRef: string; actionRef: string }> | Readonly<{ kind: "uncertain" }>;
export type FinancialBookingObservationContext = Readonly<{
  kind: "observation"; recallRef: string; recallAt: string; createdAt: string; updatedAt: string;
  recalled: boolean; archivedAt: string | null; observation: ClinikoFinancialBookingObservation;
}>;
const invalid = (): Result<never, FinancialRecordFailure> => err({ kind: "invalidQuery" });

/** Approved non-patient owner configuration only. Never hashes a patient, quote,
 * action, note or provider result. The native retainer requires a matching
 * durable barrier; a caller cannot substitute another clinic/account's journal. */
export function financialRecordOwnerBinding(config: FinancialRecordRetentionConfig): Result<string, FinancialRecordFailure> {
  try {
    if (!financialConfigShard(config, fetch) || typeof config.producer?.keyRef !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.producer.keyRef) ||
        !(config.producer.publicKey instanceof KeyObject) || config.producer.publicKey.type !== "public" ||
        config.producer.publicKey.asymmetricKeyType !== "ed25519") return err({ kind: "invalidConfig" });
    const s = financialSelection(config), key = createHash("sha256").update(config.producer.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    return ok(createHash("sha256").update(JSON.stringify(["abby.financial-record-owner.v1",
      [s.scope.tenantId, s.scope.clinicId, s.scope.locationId], s.businessId, s.credentialFingerprint, s.recallTypeId,
      [s.stripe.accountRef, s.stripe.livemode], config.producer.keyRef, key])).digest("hex"));
  } catch { return err({ kind: "invalidConfig" }); }
}

/** Private provider-bound storage only. It retains prospective context and
 * producer observations, never money or clinical permission. A failure after an
 * acknowledged booking cannot erase that booking. No local pending payload,
 * POST retry, note update, financial action, sender or public route exists here.
 * Provider contract: https://docs.api.cliniko.com/openapi/recall */
export class ClinikoFinancialRecordRetainer {
  readonly #native: FinancialRecordTransport;
  readonly #selection: ClinikoFinancialReviewSelection;
  readonly #binding: string;
  readonly #keyRef: string;
  readonly #publicKey: KeyObject;
  private constructor(config: FinancialRecordRetentionConfig, shard: string, binding: string,
                      authority: FinancialRecordAuthority, barrier: FinancialEffectBarrier, port: typeof fetch) {
    this.#native = new FinancialRecordTransport(config, shard, authority, barrier, port);
    this.#selection = this.#native.selection(); this.#binding = binding;
    this.#keyRef = config.producer.keyRef; this.#publicKey = config.producer.publicKey;
  }
  static create(config: FinancialRecordRetentionConfig, authority: FinancialRecordAuthority,
                barrier: FinancialEffectBarrier, port: typeof fetch = fetch): Result<ClinikoFinancialRecordRetainer, FinancialRecordFailure> {
    try {
      const shard = financialConfigShard(config, port), binding = financialRecordOwnerBinding(config);
      if (!shard || !binding.ok || typeof authority?.allows !== "function" || typeof authority.producerAdmitted !== "function" ||
          typeof authority.current !== "function" || typeof barrier?.matches !== "function" || typeof barrier.claimOnce !== "function" ||
          barrier.matches(financialSelection(config).scope, binding.value) !== true) return err({ kind: "invalidConfig" });
      return ok(new ClinikoFinancialRecordRetainer(config, shard, binding.value, authority, barrier, port));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  selection(): ClinikoFinancialReviewSelection { return this.#selection; }
  #intent(input: ClinikoFinancialIntent): ClinikoFinancialIntent | undefined {
    try {
      const encoded = encodeClinikoFinancialIntent(input); if (!encoded.ok) return undefined;
      const parsed = decodeClinikoFinancialIntent(encoded.value); if (!parsed.ok) return undefined;
      const i = parsed.value, s = this.#selection;
      return i.scope.tenantId === s.scope.tenantId && i.scope.clinicId === s.scope.clinicId && i.scope.locationId === s.scope.locationId &&
        i.businessId === s.businessId && i.credentialFingerprint === s.credentialFingerprint &&
        i.stripe.accountRef === s.stripe.accountRef && i.stripe.livemode === s.stripe.livemode ? i : undefined;
    } catch { return undefined; }
  }
  #query(intent: ClinikoFinancialIntent, actionRef: string, operation: FinancialRecordQuery["operation"],
         refs: Readonly<{ recallRef?: string; intentRecallRef?: string; recallAt?: string }> = {}): FinancialRecordQuery {
    return Object.freeze({ ...this.#selection, ownerBinding: this.#binding, operation, actionRef,
      financialActionRef: intent.actionRef, patientId: intent.patientId, intentDigest: financialIntentDigest(intent)!, ...refs });
  }
  /** Before possible clinical dispatch, using an explicit clinic-approved review
   * date. The UTC payment deadline is not silently converted to a local date. */
  async retainIntentOnce(input: ClinikoFinancialIntent, recallAt: string, signal: AbortSignal): Promise<Result<FinancialRecordRetention, FinancialRecordFailure>> {
    const intent = this.#intent(input); if (!intent || !validRecallDate(recallAt)) return invalid();
    const notes = encodeClinikoFinancialIntent(intent); if (!notes.ok) return invalid();
    const result = await this.#native.request({ method: "POST", query: this.#query(intent, intent.actionRef, "retainIntent", { recallAt }),
      notes: notes.value, recallAt, notAfter: intent.payment.deadline, notBefore: intent.createdAt }, signal);
    return result.ok ? ok(result.value.kind === "uncertain" ? result.value : { kind: "accepted", recallRef: result.value.recallRef, actionRef: intent.actionRef }) : result;
  }
  /** The financial service owns this signal independently of an ended caller.
   * Only an authenticated actual-producer observation can be retained. */
  async retainBookingObservationOnce(notes: unknown, expected: Readonly<{ intent: ClinikoFinancialIntent; intentRecallRef: string }>,
                                    recallAt: string, signal: AbortSignal): Promise<Result<FinancialRecordRetention, FinancialRecordFailure>> {
    const intent = this.#intent(expected?.intent), intentRecallRef = expected?.intentRecallRef; if (!intent || !validRecallDate(recallAt)) return invalid();
    const observed = verifyFinancialBookingObservation(notes, { intent, intentRecallRef,
      producerKeyRef: this.#keyRef, publicKey: this.#publicKey });
    if (!observed.ok || typeof notes !== "string") return invalid();
    const result = await this.#native.request({ method: "POST", query: this.#query(intent, observed.value.actionRef, "retainBookingObservation", { intentRecallRef, recallAt }),
      notes, recallAt }, signal);
    return result.ok ? ok(result.value.kind === "uncertain" ? result.value : { kind: "accepted", recallRef: result.value.recallRef, actionRef: observed.value.actionRef }) : result;
  }
  /** Cold exact read authenticates a retained producer observation, not a payment
   * or permission. Recalled/archived flags remain context, never financial truth. */
  async readBookingObservation(binding: Readonly<{ recallRef: string; actionRef: string; intentRecallRef: string }>,
                               expected: ClinikoFinancialIntent, signal: AbortSignal): Promise<Result<FinancialBookingObservationContext, FinancialRecordFailure>> {
    const wanted = Object.freeze({ recallRef: binding?.recallRef, actionRef: binding?.actionRef, intentRecallRef: binding?.intentRecallRef });
    const intent = this.#intent(expected), id = typeof wanted.recallRef === "string" ? /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(wanted.recallRef)?.[1] : undefined;
    if (!intent || !id || !validRecallMarker(wanted.actionRef) || !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(wanted.intentRecallRef) || wanted.recallRef === wanted.intentRecallRef) return invalid();
    const result = await this.#native.request({ method: "GET", recallId: id,
      query: this.#query(intent, wanted.actionRef, "readBookingObservation", { recallRef: wanted.recallRef, intentRecallRef: wanted.intentRecallRef }) }, signal);
    if (!result.ok) return result;
    if (result.value.kind !== "record") return err({ kind: "unavailable" });
    const observed = verifyFinancialBookingObservation(result.value.notes, { intent, intentRecallRef: wanted.intentRecallRef,
      producerKeyRef: this.#keyRef, publicKey: this.#publicKey });
    if (!observed.ok || observed.value.actionRef !== wanted.actionRef) return err({ kind: "mismatched" });
    const { recallRef, recallAt, createdAt, updatedAt, recalled, archivedAt } = result.value;
    return ok({ kind: "observation", recallRef, recallAt, createdAt, updatedAt, recalled, archivedAt, observation: observed.value });
  }
  /** Exact attempt evidence must be durable before the owner may invoke Stripe.
   * A consumed local effect or this record alone can never authorize a replay. */
  async retainCheckoutAttemptOnce(attempt: FinancialCheckoutAttempt, expected: Readonly<{
    intent: ClinikoFinancialIntent; intentRecallRef: string; observationRecallRef: string; observation: ClinikoFinancialBookingObservation;
  }>, recallAt: string, signal: AbortSignal): Promise<Result<FinancialRecordRetention, FinancialRecordFailure>> {
    const intent = this.#intent(expected?.intent), encoded = encodeFinancialCheckoutAttempt(attempt);
    if (!intent || !encoded.ok || !validRecallDate(recallAt) || !checkoutAttemptMatchesIntent(attempt, intent, expected.intentRecallRef) ||
        attempt.observationRecallRef !== expected.observationRecallRef || attempt.observationActionRef !== expected.observation.actionRef ||
        attempt.targetRef !== expected.observation.targetRef || expected.observation.financialActionRef !== intent.actionRef ||
        expected.observation.intentDigest !== financialIntentDigest(intent)) return invalid();
    const result = await this.#native.request({ method: "POST", notes: encoded.value, recallAt,
      notBefore: new Date(attempt.createdFrom * 1_000).toISOString(), notAfter: new Date(attempt.createdThrough * 1_000).toISOString(),
      query: this.#query(intent, attempt.actionRef, "retainCheckoutAttempt", { intentRecallRef: expected.intentRecallRef, recallAt }) }, signal);
    if (!result.ok) return result;
    if (result.value.kind === "record" && result.value.recallRef === attempt.observationRecallRef) return ok({ kind: "uncertain" });
    return ok(result.value.kind === "uncertain" ? result.value : { kind: "accepted", recallRef: result.value.recallRef, actionRef: attempt.actionRef });
  }
  async readCheckoutAttempt(binding: Readonly<{ recallRef: string; actionRef: string; intentRecallRef: string }>,
                            expected: ClinikoFinancialIntent, signal: AbortSignal): Promise<Result<Readonly<{
    kind: "attemptContext"; recallRef: string; recalled: boolean; archivedAt: string | null; attempt: FinancialCheckoutAttempt;
  }>, FinancialRecordFailure>> {
    const intent = this.#intent(expected), id = typeof binding?.recallRef === "string" ? /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(binding.recallRef)?.[1] : undefined;
    if (!intent || !id || !validRecallMarker(binding.actionRef) || binding.recallRef === binding.intentRecallRef) return invalid();
    const result = await this.#native.request({ method: "GET", recallId: id,
      query: this.#query(intent, binding.actionRef, "readCheckoutAttempt", { recallRef: binding.recallRef, intentRecallRef: binding.intentRecallRef }) }, signal);
    if (!result.ok) return result;
    if (result.value.kind !== "record") return err({ kind: "unavailable" });
    const attempt = decodeFinancialCheckoutAttempt(result.value.notes);
    if (!attempt.ok || !checkoutAttemptMatchesIntent(attempt.value, intent, binding.intentRecallRef) ||
        attempt.value.observationRecallRef === binding.recallRef) return err({ kind: "mismatched" });
    return ok({ kind: "attemptContext", recallRef: result.value.recallRef, recalled: result.value.recalled,
      archivedAt: result.value.archivedAt, attempt: attempt.value });
  }

  /** The independent message owner must retain this before possible SMTP send.
   * Retention is possible-send context, never delivery, money or send permission. */
  async retainMessageAttemptOnce(attempt: FinancialMessageAttempt, expected: Readonly<{
    intent: ClinikoFinancialIntent; intentRecallRef: string; observationRecallRef: string; observation: ClinikoFinancialBookingObservation;
  }>, recallAt: string, signal: AbortSignal): Promise<Result<FinancialRecordRetention, FinancialRecordFailure>> {
    const intent = this.#intent(expected?.intent), encoded = encodeFinancialMessageAttempt(attempt);
    if (!intent || !encoded.ok || !validRecallDate(recallAt) || !messageAttemptMatchesIntent(attempt, intent, expected.intentRecallRef) ||
        attempt.observationRecallRef !== expected.observationRecallRef || attempt.observationActionRef !== expected.observation.actionRef ||
        attempt.targetRef !== expected.observation.targetRef || expected.observation.financialActionRef !== intent.actionRef ||
        expected.observation.intentDigest !== financialIntentDigest(intent)) return invalid();
    const at = Date.parse(attempt.attemptedAt);
    const result = await this.#native.request({ method: "POST", notes: encoded.value, recallAt,
      notBefore: new Date(at - 30_000).toISOString(), notAfter: new Date(at + 60_000).toISOString(),
      query: this.#query(intent, attempt.actionRef, "retainMessageAttempt", { intentRecallRef: expected.intentRecallRef, recallAt }) }, signal);
    if (!result.ok) return result;
    if (result.value.kind === "record" && [attempt.intentRecallRef, attempt.observationRecallRef].includes(result.value.recallRef)) return ok({ kind: "uncertain" });
    return ok(result.value.kind === "uncertain" ? result.value : { kind: "accepted", recallRef: result.value.recallRef, actionRef: attempt.actionRef });
  }
  async readMessageAttempt(binding: Readonly<{ recallRef: string; actionRef: string; intentRecallRef: string }>,
                           expected: ClinikoFinancialIntent, signal: AbortSignal): Promise<Result<Readonly<{
    kind: "messageAttemptContext"; recallRef: string; recalled: boolean; archivedAt: string | null; attempt: FinancialMessageAttempt;
  }>, FinancialRecordFailure>> {
    const intent = this.#intent(expected), id = typeof binding?.recallRef === "string" ? /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(binding.recallRef)?.[1] : undefined;
    if (!intent || !id || !validRecallMarker(binding.actionRef) || binding.recallRef === binding.intentRecallRef) return invalid();
    const result = await this.#native.request({ method: "GET", recallId: id,
      query: this.#query(intent, binding.actionRef, "readMessageAttempt", { recallRef: binding.recallRef, intentRecallRef: binding.intentRecallRef }) }, signal);
    if (!result.ok) return result;
    if (result.value.kind !== "record") return err({ kind: "unavailable" });
    const attempt = decodeFinancialMessageAttempt(result.value.notes);
    if (!attempt.ok || attempt.value.actionRef !== binding.actionRef || !messageAttemptMatchesIntent(attempt.value, intent, binding.intentRecallRef) ||
        attempt.value.observationRecallRef === binding.recallRef) return err({ kind: "mismatched" });
    return ok({ kind: "messageAttemptContext", recallRef: result.value.recallRef, recalled: result.value.recalled,
      archivedAt: result.value.archivedAt, attempt: attempt.value });
  }

  /** The independent expiry owner must retain this before possible Checkout or clinical dispatch.
   * Retention is possible-expiry context, never payment, clinical truth or expiry permission. */
  async retainExpiryAttemptOnce(attempt: FinancialExpiryAttempt, expected: Readonly<{
    intent: ClinikoFinancialIntent; intentRecallRef: string; observationRecallRef: string; observation: ClinikoFinancialBookingObservation;
  }>, recallAt: string, signal: AbortSignal): Promise<Result<FinancialRecordRetention, FinancialRecordFailure>> {
    const intent = this.#intent(expected?.intent), encoded = encodeFinancialExpiryAttempt(attempt);
    if (!intent || !encoded.ok || !validRecallDate(recallAt) || !expiryAttemptMatchesIntent(attempt, intent, expected.intentRecallRef) ||
        attempt.observationRecallRef !== expected.observationRecallRef || attempt.observationActionRef !== expected.observation.actionRef ||
        attempt.targetRef !== expected.observation.targetRef || expected.observation.financialActionRef !== intent.actionRef ||
        expected.observation.intentDigest !== financialIntentDigest(intent)) return invalid();
    const at = Date.parse(attempt.attemptedAt);
    const result = await this.#native.request({ method: "POST", notes: encoded.value, recallAt,
      notBefore: new Date(at - 30_000).toISOString(), notAfter: new Date(at + 60_000).toISOString(),
      query: this.#query(intent, attempt.actionRef, "retainExpiryAttempt", { intentRecallRef: expected.intentRecallRef, recallAt }) }, signal);
    if (!result.ok) return result;
    if (result.value.kind === "record" && [attempt.intentRecallRef, attempt.observationRecallRef].includes(result.value.recallRef)) return ok({ kind: "uncertain" });
    return ok(result.value.kind === "uncertain" ? result.value : { kind: "accepted", recallRef: result.value.recallRef, actionRef: attempt.actionRef });
  }
  async readExpiryAttempt(binding: Readonly<{ recallRef: string; actionRef: string; intentRecallRef: string }>,
                           expected: ClinikoFinancialIntent, signal: AbortSignal): Promise<Result<Readonly<{
    kind: "expiryAttemptContext"; recallRef: string; recalled: boolean; archivedAt: string | null; attempt: FinancialExpiryAttempt;
  }>, FinancialRecordFailure>> {
    const intent = this.#intent(expected), id = typeof binding?.recallRef === "string" ? /^cliniko:recall:([1-9][0-9]{0,18})$/.exec(binding.recallRef)?.[1] : undefined;
    if (!intent || !id || !validRecallMarker(binding.actionRef) || binding.recallRef === binding.intentRecallRef) return invalid();
    const result = await this.#native.request({ method: "GET", recallId: id,
      query: this.#query(intent, binding.actionRef, "readExpiryAttempt", { recallRef: binding.recallRef, intentRecallRef: binding.intentRecallRef }) }, signal);
    if (!result.ok) return result;
    if (result.value.kind !== "record") return err({ kind: "unavailable" });
    const attempt = decodeFinancialExpiryAttempt(result.value.notes);
    if (!attempt.ok || attempt.value.actionRef !== binding.actionRef || !expiryAttemptMatchesIntent(attempt.value, intent, binding.intentRecallRef) ||
        attempt.value.observationRecallRef === binding.recallRef) return err({ kind: "mismatched" });
    return ok({ kind: "expiryAttemptContext", recallRef: result.value.recallRef, recalled: result.value.recalled,
      archivedAt: result.value.archivedAt, attempt: attempt.value });
  }

}
