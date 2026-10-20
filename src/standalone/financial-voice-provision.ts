import { inheritClinikoRequestCost } from "../cliniko/request-cost.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { LocationScope } from "../core/model.ts";
import { sameScope } from "./appointment-change-authority.ts";
import type { FinancialBookingPreparationConfig, FinancialBookingPolicy, FinancialBookingPolicyCallContext } from "./cliniko-financial-booking-preparation.ts";

export type FinancialVoiceProvision = Omit<FinancialBookingPreparationConfig, "presentation" | "policy"> & (
  | Readonly<{ policy: FinancialBookingPolicy; policyForCall?: never }>
  | Readonly<{ policy?: never; policyForCall(context: FinancialBookingPolicyCallContext): FinancialBookingPolicy }>
);
const policyMethods = (policy: FinancialBookingPolicy | undefined) => !!policy &&
  [policy.quote, policy.current, policy.currentForSend].every(method => typeof method === "function");
function policySnapshot(policy: FinancialBookingPolicy): FinancialBookingPolicy {
  const { ownership, quote, current, currentForSend } = policy;
  if (![quote, current, currentForSend].every(method => typeof method === "function") || ownership !== undefined && ownership !== "call")
    throw new RangeError("clinical financial policy unavailable");
  return Object.freeze({ ...(ownership ? { ownership } : {}), quote: inheritClinikoRequestCost(quote.bind(policy), quote),
    current: inheritClinikoRequestCost(current.bind(policy), current), currentForSend: currentForSend.bind(policy) });
}

/** Capture trusted service ports once; incoming and outgoing voice use exactly
 * the same account/budget and policy-ownership checks. No call presentation is
 * accepted until the actual admitted call binds it below. */
export function captureFinancialVoiceProvision(financial: FinancialVoiceProvision,
  binding: Readonly<{ scope: LocationScope; businessId: string; apiKey: string; rateBudget: ClinikoRequestBudget }>): FinancialVoiceProvision {
  if (!sameScope(financial.native.scope, binding.scope) || financial.native.businessId !== binding.businessId ||
      clinikoCredentialFingerprint(financial.native.apiKey) !== clinikoCredentialFingerprint(binding.apiKey) ||
      financial.native.rateBudget !== binding.rateBudget) throw new RangeError("invalid clinical financial binding");
  if (financial.policyForCall !== undefined ? typeof financial.policyForCall !== "function" || financial.policy !== undefined
    : !policyMethods(financial.policy) || financial.policy!.ownership === "call") throw new RangeError("invalid clinical financial policy ownership");
  return Object.freeze({ native: Object.freeze({ ...financial.native, scope: Object.freeze({ ...financial.native.scope }),
      stripe: Object.freeze({ ...financial.native.stripe }), producer: Object.freeze({ ...financial.native.producer }) }),
    privateKey: financial.privateKey, financialSignal: financial.financialSignal,
    sourceAuthorized: inheritClinikoRequestCost(financial.sourceAuthorized.bind(financial), financial.sourceAuthorized),
    authority: Object.freeze({ allows: inheritClinikoRequestCost(financial.authority.allows.bind(financial.authority), financial.authority.allows),
      producerAdmitted: inheritClinikoRequestCost(financial.authority.producerAdmitted.bind(financial.authority), financial.authority.producerAdmitted),
      current: financial.authority.current.bind(financial.authority) }),
    ...(financial.policyForCall ? { policyForCall: financial.policyForCall.bind(financial) } : { policy: policySnapshot(financial.policy!) }),
    barrier: Object.freeze({ matches: financial.barrier.matches.bind(financial.barrier), claimOnce: financial.barrier.claimOnce.bind(financial.barrier) }),
    ...(financial.fetchPort ? { fetchPort: financial.fetchPort } : {}) });
}

/** The host owns the reuse set; it contains only policy object identities, no
 * patient/call data. A call-owned mutable policy cannot cross two live calls. */
export function financialVoiceForCall(financial: FinancialVoiceProvision, incoming: FinancialBookingPolicyCallContext,
  presentation: FinancialBookingPreparationConfig["presentation"], usedPolicies: WeakSet<object>): FinancialBookingPreparationConfig {
  const context = Object.freeze({ ...incoming, scope: Object.freeze({ ...incoming.scope }) });
  if (!sameScope(context.scope, financial.native.scope) || !context.callId || !context.sessionId ||
      !(context.signal instanceof AbortSignal) || context.signal.aborted || typeof context.clock !== "function" ||
      typeof presentation?.play !== "function") throw new RangeError("clinical voice admission mismatch");
  const { policyForCall, policy: sharedPolicy, ...common } = financial;
  try {
    const policy = policyForCall ? policyForCall(context) : sharedPolicy;
    if (!policyMethods(policy) || policyForCall && usedPolicies.has(policy!)) throw new RangeError("clinical financial policy unavailable");
    const snapshot = policySnapshot(policy!);
    if (policyForCall) usedPolicies.add(policy!);
    return { ...common, native: { ...common.native, clock: context.clock }, policy: snapshot,
      presentation: Object.freeze({ play: presentation.play.bind(presentation) }) };
  } catch { throw new RangeError("clinical financial policy unavailable"); }
}
