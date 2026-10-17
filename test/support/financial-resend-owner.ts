import { randomUUID } from "node:crypto";
import { financialMessageFixture, value, now, stop } from "./financial-message-owner.ts";
import { resendRequestValue } from "./financial-resend.ts";
import { financialRecordOwnerBinding } from "../../src/cliniko/financial-record-retention.ts";
import { ClinikoFinancialResendRecords } from "../../src/cliniko/financial-resend-records.ts";
import { financialResendRequestDigest } from "../../src/cliniko/financial-resend-request.ts";
import type { FinancialResendRequest } from "../../src/cliniko/financial-resend-request.ts";
import type { FinancialMessagePurpose } from "../../src/cliniko/financial-message-attempt.ts";
import { ClinikoReadBudget } from "../../src/cliniko/read-budget.ts";
import { financialMessageSelectionDigest } from "../../src/standalone/smtp-financial-message-delivery.ts";
import { ClinikoFinancialResendOwner } from "../../src/standalone/cliniko-financial-resend-owner.ts";
import type { FinancialResendAuthority } from "../../src/standalone/cliniko-financial-resend-owner.ts";

export async function financialResendFixture(options: { message?: Parameters<typeof financialMessageFixture>[0];
  authority?: Partial<FinancialResendAuthority>; purpose?: FinancialMessagePurpose } = {}) {
  let claims = 0, budget!: ClinikoReadBudget, allowed = true, financial = true, live = true;
  const headrooms: { required: number; claims: number; admitted: boolean }[] = [], effects = new Set<string>(), burned = new Set<string>(),
    claimsAtEffect = new Map<string, number>(), approved = new Map<string, string>();
  const source = options.message?.checkout?.native, baseFactory = source?.barrierFactory;
  const f = await financialMessageFixture({ ...options.message, checkout: { ...options.message?.checkout, native: { ...source,
    barrierFactory(config) {
      budget = new ClinikoReadBudget(180, () => Date.parse(config.clock?.() ?? now));
      Object.assign(config.rateBudget, { claim: () => { claims++; return budget.claim(); }, observe429: budget.observe429.bind(budget),
        checkHeadroom: (required: number) => { const result = budget.checkHeadroom(required); headrooms.push({ required, claims, admitted: result === null }); return result; } });
      const binding = value(financialRecordOwnerBinding(config)), actual = baseFactory?.(config) ?? {
        matches: (scope: typeof config.scope, owner: string) => JSON.stringify(scope) === JSON.stringify(config.scope) && owner === binding,
        claimOnce: async (id: string) => { const claimed = !burned.has(id); burned.add(id); return { ok: true as const, value: { claimed } }; },
      };
      return { matches: actual.matches.bind(actual), claimOnce: async id => { if (effects.has(id)) claimsAtEffect.set(id, claims); return actual.claimOnce(id); } };
    } } } });
  const authority: FinancialResendAuthority = { allows: async q => allowed && approved.get(q.resend.request.approvalRef) === financialResendRequestDigest(q.resend.request),
    financialAuthorized: async () => financial, current: () => live, ...options.authority };
  const config = { ...f.config, maximumAuthorityRequests: 0 };
  const records = value(ClinikoFinancialResendRecords.create(config.cliniko, f.recordsAuthority, f.barrier, f.nativePort));
  const make = () => ClinikoFinancialResendOwner.create(config, f.authority, authority, f.recordsAuthority, f.barrier, f.delivery, f.nativePort, f.stripePort);
  const owner = value(make());
  const createRequest = async (purpose: FinancialMessagePurpose = "linkDelivery", patch: Partial<FinancialResendRequest> = {}) => {
    const request = resendRequestValue(f.intent, { actionRef: randomUUID(), effectRef: randomUUID(), approvalRef: randomUUID(), purpose,
      intentRecallRef: f.binding.intentRecallRef, observationRecallRef: f.binding.observationRecallRef, observationActionRef: f.binding.observationActionRef,
      checkoutAttemptRecallRef: f.binding.checkoutAttemptRecallRef, checkoutAttemptActionRef: f.binding.checkoutAttemptActionRef,
      checkoutRef: f.binding.checkoutRef, selectionDigest: financialMessageSelectionDigest(f.delivery.selection())!, ...patch });
    effects.add(request.effectRef); const retained = value(await records.retainRequestOnce(request, f.intent, "2026-11-02", stop()));
    if (retained.kind !== "accepted") throw new Error("Synthetic explicit request unavailable");
    approved.set(request.approvalRef, financialResendRequestDigest(request)!);
    return { request, binding: { recallRef: retained.recallRef, actionRef: request.actionRef } };
  };
  const selected = await createRequest(options.purpose);
  return { ...f, resendConfig: config, resendAuthority: authority, resendRecords: records, resendOwner: owner, makeResend: make,
    selected, createRequest, headrooms, claimsAtEffect, burned, budget, get claims() { return claims; },
    resend: (choice = selected, signal = stop()) => owner.sendOnce(f.binding, choice.request.purpose, choice.binding, signal),
    denyResend: () => { allowed = false; }, denyFinancial: () => { financial = false; }, retireResend: () => { live = false; } };
}
export { value, now, stop };
