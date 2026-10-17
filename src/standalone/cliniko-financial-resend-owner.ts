import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { err, ok } from "../core/model.ts";
import type { Result } from "../core/model.ts";
import { checkClinikoHeadroom } from "../cliniko/read-budget.ts";
import { ClinikoFinancialResendRecords } from "../cliniko/financial-resend-records.ts";
import type { FinancialResendContext } from "../cliniko/financial-resend-records.ts";
import { resendRequestMatchesIntent, financialResendRequestDigest } from "../cliniko/financial-resend-request.ts";
import { encodeFinancialResendAttempt } from "../cliniko/financial-resend-attempt.ts";
import type { FinancialResendAttempt } from "../cliniko/financial-resend-attempt.ts";
import type { FinancialRecordAuthority } from "../cliniko/financial-record-retention.ts";
import { validRecallMarker } from "../cliniko/recall-note.ts";
import type { FinancialMessagePurpose } from "../cliniko/financial-message-attempt.ts";
import type { FinancialEffectBarrier } from "./financial-effect-barrier.ts";
import { financialMessageSelectionDigest } from "./smtp-financial-message-delivery.ts";
import type { FinancialMessageDelivery } from "./smtp-financial-message-delivery.ts";
import { FinancialMessageProtocol, FinancialMessageProtocolRefusal } from "./financial-message-protocol.ts";
import type { FinancialMessageQuery, FinancialMessageMode, FinancialMessageOwnerConfig, FinancialMessageAuthority,
  FinancialMessageBinding, FinancialMessageOutcome, FinancialMessageFailure } from "./financial-message-protocol.ts";

export type FinancialResendBinding = Readonly<{ recallRef: string; actionRef: string }>;
export type FinancialResendQuery = FinancialMessageQuery & Readonly<{ resend: FinancialResendContext }>;
/** Independent current approval of the exact native request, original recipient,
 * selected sender/template and consequence. Notes or old message permission
 * cannot supply this grant; producer/restore and all financial grants remain. */
export type FinancialResendAuthority = Readonly<{
  allows(query: FinancialResendQuery, signal: AbortSignal): Promise<boolean>;
  /** Current fees/manual-paid/waiver and financial permission for this purpose. */
  financialAuthorized(query: FinancialResendQuery, signal: AbortSignal): Promise<boolean>;
  current(query: FinancialResendQuery, signal: AbortSignal): boolean;
}>;
export type FinancialResendConfig = FinancialMessageOwnerConfig & Readonly<{
  /** Reviewed bound for every extra native call made by authority ports. Every
   * actual call still claims the same physical account; headroom is not a hold. */
  maximumAuthorityRequests: number;
}>;
const refuse = (): never => { throw new FinancialMessageProtocolRefusal("forbidden"); };
const queryOf = (q: FinancialMessageQuery): FinancialResendQuery => q.resend ? q as FinancialResendQuery : refuse();

/** Concrete explicit resend only. No arbitrary effect/payload override or retry
 * flag reaches the shared message protocol. A new independent request is needed
 * after consumed, ambiguous, denied or expired preparation. */
export class ClinikoFinancialResendOwner {
  readonly #build: (request: FinancialResendBinding) => Result<FinancialMessageProtocol, FinancialMessageFailure>;
  private constructor(build: (request: FinancialResendBinding) => Result<FinancialMessageProtocol, FinancialMessageFailure>) { this.#build = build; }
  static create(config: FinancialResendConfig, authority: FinancialMessageAuthority, resend: FinancialResendAuthority,
    recordAuthority: FinancialRecordAuthority, barrier: FinancialEffectBarrier, delivery: FinancialMessageDelivery,
    native: typeof fetch = fetch, stripe: typeof fetch = fetch): Result<ClinikoFinancialResendOwner, FinancialMessageFailure> {
    try {
      if (!Number.isSafeInteger(config?.maximumAuthorityRequests) || config.maximumAuthorityRequests < 0 || config.maximumAuthorityRequests > 180 ||
          typeof resend?.allows !== "function" || typeof resend.financialAuthorized !== "function" || typeof resend.current !== "function") return err({ kind: "invalidConfig" });
      const base: FinancialMessageMode = { query: async q => q, hasPrior: () => false, plan: () => undefined };
      const validated = FinancialMessageProtocol.create(config, authority, recordAuthority, barrier, delivery, base, native, stripe);
      if (!validated.ok) return validated;
      const grants = Object.freeze({ sourceAuthorized: authority.sourceAuthorized.bind(authority), attemptScanAuthorized: authority.attemptScanAuthorized.bind(authority),
        providerBindingAuthorized: authority.providerBindingAuthorized.bind(authority), messageAuthorized: authority.messageAuthorized.bind(authority),
        producerAdmitted: authority.producerAdmitted.bind(authority), current: authority.current.bind(authority) });
      const approved = Object.freeze({ allows: resend.allows.bind(resend), financialAuthorized: resend.financialAuthorized.bind(resend), current: resend.current.bind(resend) });
      const recordsGrant = Object.freeze({ allows: recordAuthority.allows.bind(recordAuthority), producerAdmitted: recordAuthority.producerAdmitted.bind(recordAuthority), current: recordAuthority.current.bind(recordAuthority) });
      const journal = Object.freeze({ matches: barrier.matches.bind(barrier), claimOnce: barrier.claimOnce.bind(barrier) });
      const mail = Object.freeze({ selection: delivery.selection.bind(delivery), send: delivery.send.bind(delivery) });
      const budget = config.cliniko.rateBudget;
      const clock = config.cliniko.clock?.bind(config.cliniko) ?? (() => new Date().toISOString());
      config = Object.freeze({ ...config, cliniko: Object.freeze({ ...config.cliniko, clock, scope: Object.freeze({ ...config.cliniko.scope }),
        stripe: Object.freeze({ ...config.cliniko.stripe }), producer: Object.freeze({ ...config.cliniko.producer }),
        rateBudget: Object.freeze({ claim: budget.claim.bind(budget), observe429: budget.observe429.bind(budget),
          ...(budget.checkHeadroom ? { checkHeadroom: budget.checkHeadroom.bind(budget) } : {}) }) }), stripe: Object.freeze({ ...config.stripe }) });
      const captured = config, made = ClinikoFinancialResendRecords.create(captured.cliniko, recordsGrant, journal, native);
      if (!made.ok) return err({ kind: "invalidConfig" }); const records = made.value;
      return ok(new ClinikoFinancialResendOwner(selector => {
        const began = Date.parse(clock());
        const valid = (q: FinancialResendQuery): boolean => {
          const r = q.resend, request = r.request, b = q.binding, now = clock(), at = Date.parse(now);
          return !r.recalled && r.archivedAt === null && Number.isFinite(began) && Number.isFinite(at) && new Date(at).toISOString() === now && at >= began &&
            now >= request.requestedAt && now < request.expiresAt && resendRequestMatchesIntent(request, q.sources.intent.intent, b.intentRecallRef) &&
            request.observationRecallRef === b.observationRecallRef && request.observationActionRef === b.observationActionRef &&
            request.targetRef === q.sources.booking.observation.targetRef && request.checkoutAttemptRecallRef === b.checkoutAttemptRecallRef &&
            request.checkoutAttemptActionRef === b.checkoutAttemptActionRef && request.checkoutRef === b.checkoutRef && request.purpose === q.message.purpose &&
            request.selectionDigest === financialMessageSelectionDigest(q.selection);
        };
        const read = async (q: FinancialMessageQuery, signal: AbortSignal) => {
          const found = await records.readRequest({ ...selector, intentRecallRef: q.binding.intentRecallRef }, q.sources.intent.intent, signal);
          if (!found.ok) return refuse(); return found.value;
        };
        const mode: FinancialMessageMode = {
          async query(q, op) {
            const context = await op.wait(read(q, op.signal)), result: FinancialResendQuery = { ...q, effectRef: context.request.effectRef, resend: context };
            if (!valid(result)) return refuse(); return Object.freeze(result);
          },
          async authorize(q, op) {
            const selected = queryOf(q); if (!valid(selected) || approved.current(selected, op.signal) !== true) return false;
            const current = await op.wait(read(selected, op.signal));
            if (!isDeepStrictEqual(current, selected.resend) || !valid(selected)) return false;
            for (const grant of [approved.allows, approved.financialAuthorized]) {
              if (await op.wait(Promise.resolve().then(() => grant(selected, op.signal))) !== true ||
                  approved.current(selected, op.signal) !== true || !valid(selected) || op.signal.aborted) return false;
            }
            return true;
          },
          extraClaims: q => [queryOf(q).resend.request.approvalRef],
          beforeClaim: async (_q, op) => await op.wait(checkClinikoHeadroom(captured.cliniko.rateBudget, 8 + captured.maximumAuthorityRequests)) === null,
          hasPrior: (history, q) => { const r = queryOf(q).resend.request; return history.resendAttempts?.some(a => a.attempt.effectRef === r.effectRef ||
            a.attempt.requestActionRef === r.actionRef || a.attempt.approvalRef === r.approvalRef) ?? false; },
          plan(q, _originalRecords, at) {
            const selected = queryOf(q), r = selected.resend, request = r.request;
            const attempt: FinancialResendAttempt = Object.freeze({ actionRef: randomUUID(), financialActionRef: request.financialActionRef,
              effectRef: request.effectRef, approvalRef: request.approvalRef, requestRecallRef: r.recallRef, requestActionRef: request.actionRef,
              requestDigest: financialResendRequestDigest(request)!, purpose: request.purpose, intentRecallRef: request.intentRecallRef,
              intentDigest: request.intentDigest, observationRecallRef: request.observationRecallRef, observationActionRef: request.observationActionRef,
              targetRef: request.targetRef, checkoutRef: request.checkoutRef, payloadDigest: q.payloadDigest, attemptedAt: at });
            if (!valid(selected) || !encodeFinancialResendAttempt(attempt).ok) return undefined;
            const source = { intent: q.sources.intent.intent, requestRecallRef: r.recallRef, request };
            return { retain: signal => records.retainAttemptOnce(attempt, source, q.sources.intent.recallAt, signal), matches: async (recallRef, signal) => {
              const found = await records.readAttempt({ recallRef, actionRef: attempt.actionRef, intentRecallRef: request.intentRecallRef }, source, signal);
              return found.ok && !found.value.recalled && found.value.archivedAt === null && isDeepStrictEqual(found.value.attempt, attempt);
            } };
          },
        };
        return FinancialMessageProtocol.create(captured, grants, recordsGrant, journal, mail, mode, native, stripe);
      }));
    } catch { return err({ kind: "invalidConfig" }); }
  }
  async sendOnce(binding: FinancialMessageBinding, purpose: FinancialMessagePurpose, request: FinancialResendBinding,
    signal: AbortSignal): Promise<Result<FinancialMessageOutcome, FinancialMessageFailure>> {
    try {
      if (!request || Object.keys(request).sort().join(",") !== "actionRef,recallRef" || !validRecallMarker(request.actionRef) ||
          typeof request.recallRef !== "string" || !/^cliniko:recall:[1-9][0-9]{0,18}$/.test(request.recallRef)) return err({ kind: "invalidQuery" });
      const protocol = this.#build(Object.freeze({ ...request }));
      return protocol.ok ? protocol.value.sendOnce(binding, purpose, signal) : protocol;
    } catch { return err({ kind: "unavailable" }); }
  }
}
