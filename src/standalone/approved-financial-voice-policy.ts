import { ClinikoFinancialBookingRecipient } from "../cliniko/financial-booking-recipient.ts";
import type { FinancialRecipientAuthority } from "../cliniko/financial-booking-recipient.ts";
import type { ClinikoFinancialReviewConfig } from "../cliniko/financial-review-read.ts";
import { ApprovedFinancialBookingPolicy } from "./approved-financial-booking-policy.ts";
import { OwnerFileFinancialFeePolicy } from "./owner-file-financial-fee-policy.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { FinancialBookingPolicyCallContext, FinancialBookingPolicy } from "./cliniko-financial-booking-preparation.ts";

/** Explicit voice-host factory. Only public approvals and independent grant ports
 * are shared: every admitted call gets its own native recipient and quote state.
 * Construction and call binding perform no I/O and start no service or consumer. */
export function approvedFinancialVoicePolicy(config: Readonly<{
  fees: OwnerFileFinancialFeePolicy; native: ClinikoFinancialReviewConfig;
  recipientAuthority: FinancialRecipientAuthority; fetchPort?: typeof fetch;
}>): (context: FinancialBookingPolicyCallContext) => FinancialBookingPolicy {
  if (!(config.fees instanceof OwnerFileFinancialFeePolicy)) throw new TypeError("Invalid financial voice policy");
  const checked = ClinikoFinancialBookingRecipient.create(config.native, config.recipientAuthority, config.fetchPort);
  if (!checked.ok) throw new TypeError("Invalid financial voice policy");
  const native = Object.freeze({ ...config.native, scope: Object.freeze({ ...config.native.scope }), stripe: Object.freeze({ ...config.native.stripe }) });
  const authority = Object.freeze({ allows: config.recipientAuthority.allows.bind(config.recipientAuthority), current: config.recipientAuthority.current.bind(config.recipientAuthority) });
  const fees = config.fees, port = config.fetchPort;
  return (context: FinancialBookingPolicyCallContext) => {
    if (!sameScope(context.scope, native.scope) || typeof context.callId !== "string" || !context.callId ||
        typeof context.sessionId !== "string" || !context.sessionId || !(context.signal instanceof AbortSignal) || context.signal.aborted || typeof context.clock !== "function") throw new TypeError("Invalid financial call binding");
    const call = Object.freeze({ ...context, scope: Object.freeze({ ...context.scope }) });
    const made = ClinikoFinancialBookingRecipient.create({ ...native, clock: call.clock }, authority, port);
    if (!made.ok) throw new TypeError("Invalid financial call binding");
    const reader = made.value;
    const matches = (s: Parameters<typeof reader.read>[0]) => !call.signal.aborted && sameScope(s.scope, call.scope) && s.callId === call.callId && s.sessionId === call.sessionId;
    const owner = new ApprovedFinancialBookingPolicy({ fees, clock: call.clock, recipient: {
      read: (selection, signal) => matches(selection) ? reader.read(selection, AbortSignal.any([signal, call.signal])) : Promise.resolve(undefined),
      currentForSend: (selection, recipient, signal) => matches(selection) && reader.currentForSend(selection, recipient, signal)
    } });
    const combined = (signal: AbortSignal) => AbortSignal.any([signal, call.signal]);
    return Object.freeze({ ownership: "call" as const,
      quote: (selection, signal) => matches(selection) ? owner.quote(selection, combined(signal)) : Promise.resolve(undefined),
      current: (selection, assessment, signal) => matches(selection) ? owner.current(selection, assessment, combined(signal)) : Promise.resolve(false),
      currentForSend: (selection, assessment, signal) => matches(selection) && owner.currentForSend(selection, assessment, signal)
    } satisfies FinancialBookingPolicy);
  };
}
