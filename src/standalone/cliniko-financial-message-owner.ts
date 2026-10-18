import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import { encodeFinancialMessageAttempt } from "../cliniko/financial-message-attempt.ts";
import type { FinancialMessageAttempt, FinancialMessagePurpose } from "../cliniko/financial-message-attempt.ts";
import { financialIntentDigest } from "../cliniko/financial-booking-observation.ts";
import type { FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import type { FinancialMessageDelivery } from "./smtp-financial-message-delivery.ts";
import { FinancialMessageProtocol } from "./financial-message-protocol.ts";
import type { FinancialMessageMode, FinancialMessageOwnerConfig, FinancialMessageAuthority, FinancialMessageBinding,
  FinancialMessageOutcome, FinancialMessageFailure } from "./financial-message-protocol.ts";
export type { FinancialMessageBinding, FinancialMessageSourceQuery, FinancialMessageQuery, FinancialMessageAuthority,
  FinancialMessageOwnerConfig, FinancialMessageFailure, FinancialMessageOutcome } from "./financial-message-protocol.ts";

/** Original one-use delivery only. Concrete mode preserves its original effect,
 * history and possible-message receipt contract; no resend override exists. */
export class ClinikoFinancialMessageOwner {
  readonly #protocol: FinancialMessageProtocol;
  private constructor(protocol: FinancialMessageProtocol) { this.#protocol = protocol; }
  static create(config: FinancialMessageOwnerConfig, authority: FinancialMessageAuthority, recordsAuthority: FinancialRecordAuthority,
    barrier: FinancialEffectBarrier, delivery: FinancialMessageDelivery, native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<ClinikoFinancialMessageOwner, FinancialMessageFailure> {
    const budget = config?.cliniko?.rateBudget;
    const mode: FinancialMessageMode = {
      query: async q => q,
      hasPrior: (history, q) => history.messageAttempts?.some(r => r.attempt.effectRef === q.effectRef ||
        r.attempt.financialActionRef === q.sources.intent.intent.actionRef && r.attempt.purpose === q.message.purpose) ?? false,
      // Own remaining native I/O: one possible-attempt POST, three fresh source
      // reads and its exact attempt reread. Refuse known insufficiency before
      // consuming the permanent message claim. This minimum is not a hold or a
      // bound on additional authority I/O; every request still claims normally.
      beforeClaim: async (_query, op) => budget !== undefined && await op.wait(checkClinikoHeadroom(budget, 5)) === null,
      plan(q, records, at) {
        const b = q.binding, sources = q.sources;
        const attempt: FinancialMessageAttempt = Object.freeze({ actionRef: randomUUID(), financialActionRef: b.financialActionRef,
          effectRef: q.effectRef, purpose: q.message.purpose, intentRecallRef: b.intentRecallRef, intentDigest: financialIntentDigest(sources.intent.intent)!,
          observationRecallRef: b.observationRecallRef, observationActionRef: b.observationActionRef, targetRef: sources.booking.observation.targetRef,
          checkoutRef: b.checkoutRef, payloadDigest: q.payloadDigest, attemptedAt: at });
        if (!encodeFinancialMessageAttempt(attempt).ok) return undefined;
        return { retain: signal => records.retainMessageAttemptOnce(attempt, { intent: sources.intent.intent,
          intentRecallRef: b.intentRecallRef, observationRecallRef: b.observationRecallRef, observation: sources.booking.observation }, sources.intent.recallAt, signal),
        matches: async (recallRef, signal) => {
          const exact = await records.readMessageAttempt({ recallRef, actionRef: attempt.actionRef, intentRecallRef: b.intentRecallRef }, sources.intent.intent, signal);
          return exact.ok && !exact.value.recalled && exact.value.archivedAt === null && isDeepStrictEqual(exact.value.attempt, attempt);
        } };
      },
    };
    const protocol = FinancialMessageProtocol.create(config, authority, recordsAuthority, barrier, delivery, mode, native, stripe);
    return protocol.ok ? ok(new ClinikoFinancialMessageOwner(protocol.value)) : protocol;
  }
  sendOnce(binding: FinancialMessageBinding, purpose: FinancialMessagePurpose, signal: AbortSignal): Promise<Result<FinancialMessageOutcome, FinancialMessageFailure>> {
    return this.#protocol.sendOnce(binding, purpose, signal);
  }
}
