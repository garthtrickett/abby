import { callIdFor } from "../voice/admission.ts";
import { inheritClinikoRequestCost } from "../cliniko/request-cost.ts";
import type { FinancialBookingPreparationConfig, FinancialBookingPolicy, FinancialBookingPolicyCallContext } from "./cliniko-financial-booking-preparation.ts";
import { captureConfirmationResendPolicy } from "./capture-confirmation-resend-policy.ts";
import { clinikoCredentialFingerprint } from "../cliniko/read-budget.ts";
import type { ClinikoRequestBudget } from "../cliniko/read-budget.ts";
import type { ClinikoSelectionApproval } from "../cliniko/catalogue-setup.ts";
import type { ApprovedGreeting, LocationScope } from "../core/model.ts";
import { err } from "../core/model.ts";
import type { PolicyStore } from "../core/host.ts";
import { validGreetingShape } from "../core/greeting.ts";
import { sameScope } from "./appointment-change-authority.ts";
import { ClinikoCallFlow } from "./cliniko-call-flow.ts";
import type { ClinikoCallFlowConfig } from "./cliniko-call-flow.ts";
import type { ClinikoVoiceWorkflow } from "./transient-voice-composition.ts";

export type FinancialVoiceProvision = Omit<FinancialBookingPreparationConfig, "presentation" | "policy"> & (
  | Readonly<{ policy: FinancialBookingPolicy; policyForCall?: never }>
  | Readonly<{ policy?: never; policyForCall(context: FinancialBookingPolicyCallContext): FinancialBookingPolicy }>
);
const policyMethods = (policy: FinancialBookingPolicy | undefined) => !!policy &&
  [policy.quote, policy.current, policy.currentForSend].every(method => typeof method === "function");
function policySnapshot(policy: FinancialBookingPolicy): FinancialBookingPolicy {
  return Object.freeze({ ...(policy.ownership ? { ownership: policy.ownership } : {}),
    quote: inheritClinikoRequestCost(policy.quote.bind(policy), policy.quote),
    current: inheritClinikoRequestCost(policy.current.bind(policy), policy.current), currentForSend: policy.currentForSend.bind(policy) });
}
type CallOwned = "receipt" | "inbound" | "sessionId" | "ledger" | "signal" | "clock";
export type ClinikoVoiceClinicalHostConfig = Omit<ClinikoCallFlowConfig, CallOwned | "intake" | "correction" | "resend" | "financial"> & Readonly<{
  scope: LocationScope;
  greeting: ApprovedGreeting;
  /** The admitted call supplies private playback; no shared/static receipt port. */
  financial?: FinancialVoiceProvision;
  intake?: Omit<NonNullable<ClinikoCallFlowConfig["intake"]>, "presentation">;
  resend?: Omit<NonNullable<ClinikoCallFlowConfig["resend"]>, "presentation">;
  correction?: Omit<NonNullable<ClinikoCallFlowConfig["correction"]>, "presentation">;
  intent: ClinikoVoiceWorkflow["intent"];
  privateIntakeTranscription?: ClinikoVoiceWorkflow["privateIntakeTranscription"];
  privateCorrectionTranscription?: ClinikoVoiceWorkflow["privateCorrectionTranscription"];
  privateRepresentativeTranscription?: ClinikoVoiceWorkflow["privateRepresentativeTranscription"];
}>;

/** Clinic-owned clinical composition. A catalogue approval remains read-only:
 * each session still checks separate caller, operation, policy and review authority.
 * This host cannot change admission readiness or manufacture a verification result. */
export class ClinikoVoiceClinicalHost {
  readonly #config: ClinikoVoiceClinicalHostConfig;
  readonly #financialPolicies = new WeakSet<object>();
  constructor(config: ClinikoVoiceClinicalHostConfig) {
    if (!validGreetingShape(config.greeting, config.scope) || typeof config.intent !== "function" ||
        config.correction && typeof config.privateCorrectionTranscription !== "function" ||
        config.representativeInput && typeof config.privateRepresentativeTranscription !== "function") {
      throw new RangeError("invalid clinical voice host");
    }
    const financial = config.financial;
    if (financial && (!sameScope(financial.native.scope, config.scope) || financial.native.businessId !== config.cliniko.businessId ||
        clinikoCredentialFingerprint(financial.native.apiKey) !== clinikoCredentialFingerprint(config.cliniko.apiKey) ||
        financial.native.rateBudget !== config.cliniko.rateBudget)) throw new RangeError("invalid clinical financial binding");
    if (financial && (financial.policyForCall !== undefined
      ? typeof financial.policyForCall !== "function" || financial.policy !== undefined
      : !policyMethods(financial.policy) || financial.policy!.ownership === "call")) throw new RangeError("invalid clinical financial policy ownership");
    const financialProvision: FinancialVoiceProvision | undefined = financial ? Object.freeze({
      native: Object.freeze({ ...financial.native, scope: Object.freeze({ ...financial.native.scope }),
        stripe: Object.freeze({ ...financial.native.stripe }), producer: Object.freeze({ ...financial.native.producer }) }),
      privateKey: financial.privateKey, financialSignal: financial.financialSignal,
      sourceAuthorized: inheritClinikoRequestCost(financial.sourceAuthorized.bind(financial), financial.sourceAuthorized),
      authority: Object.freeze({ allows: inheritClinikoRequestCost(financial.authority.allows.bind(financial.authority), financial.authority.allows),
        producerAdmitted: inheritClinikoRequestCost(financial.authority.producerAdmitted.bind(financial.authority), financial.authority.producerAdmitted),
        current: financial.authority.current.bind(financial.authority) }),
      ...(financial.policyForCall ? { policyForCall: financial.policyForCall.bind(financial) } : { policy: policySnapshot(financial.policy!) }),
      barrier: Object.freeze({ matches: financial.barrier.matches.bind(financial.barrier), claimOnce: financial.barrier.claimOnce.bind(financial.barrier) }),
      ...(financial.fetchPort ? { fetchPort: financial.fetchPort } : {}) }) : undefined;
    this.#config = Object.freeze({ ...config, scope: Object.freeze({ ...config.scope }),
      ...(financialProvision ? { financial: financialProvision } : {}),
      greeting: Object.freeze(structuredClone(config.greeting)), cliniko: Object.freeze({ ...config.cliniko }),
      approvals: Object.freeze({ ...config.approvals }),
      ...(config.classAttendance ? { classAttendance: Object.freeze({ ...config.classAttendance }) } : {}),
      ...(config.classServices ? { classServices: Object.freeze(config.classServices.map(service => Object.freeze({ ...service }))) } : {}),
      ...(config.reschedulingDestination ? { reschedulingDestination: Object.freeze({ ...config.reschedulingDestination }) } : {}),
      ...(config.reschedulingPractitioners ? { reschedulingPractitioners: Object.freeze(config.reschedulingPractitioners.map(member => Object.freeze({ ...member }))) } : {}),
      ...(config.catalogue ? { catalogue: Object.freeze({ ...config.catalogue,
        practitioners: Object.freeze(config.catalogue.practitioners.map(member => Object.freeze({ ...member }))) }) } : {}),
      ...(config.intake ? { intake: Object.freeze({ ...config.intake }) } : {}),
      ...(config.resend ? { resend: Object.freeze({ ...config.resend }) } : {}),
      ...(config.representativeInput ? { representativeInput: Object.freeze({ ...config.representativeInput }) } : {}),
      ...(config.correction ? { correction: Object.freeze({ ...config.correction }) } : {}),
      ...(config.staff ? { staff: Object.freeze({ ...config.staff }) } : {}),
      ...(config.enquiry ? { enquiry: Object.freeze({ ...config.enquiry }) } : {}),
      ...(config.history ? { history: Object.freeze({ ...config.history }) } : {}),
      ...(config.serviceCatalogue ? { serviceCatalogue: Object.freeze({ ...config.serviceCatalogue,
        services: Object.freeze(config.serviceCatalogue.services.map(service => Object.freeze({ ...service,
          practitioners: Object.freeze(service.practitioners.map(member => Object.freeze({ ...member }))) }))) }) } : {}) });
  }
  get greeting(): ApprovedGreeting { return structuredClone(this.#config.greeting); }
  get locationServiceSource() {
    const c = this.#config;
    return c.serviceCatalogue ? Object.freeze({ path: c.serviceCatalogue.approvalPath, scope: c.scope, policyVersion: c.policyVersion,
      businessId: c.cliniko.businessId, credentialFingerprint: clinikoCredentialFingerprint(c.cliniko.apiKey), timeZone: c.cliniko.timeZone,
      directory: c.directory }) : undefined;
  }
  get #policies(): PolicyStore {
    const c = this.#config;
    return new Proxy(c.policies, { get(target, key) {
      if (key === "read") return async (...args: Parameters<PolicyStore["read"]>) => {
        const loaded = await target.read(...args);
        return loaded.ok ? { ok: true as const, value: await captureConfirmationResendPolicy(loaded.value, c.resend?.policy) } : loaded;
      };
      const value = Reflect.get(target, key) as unknown; return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  get cataloguePolicy(): Pick<PolicyStore, "read"> {
    return { read: scope => sameScope(scope, this.#config.scope) ? this.#policies.read(scope)
      : Promise.resolve(err({ kind: "invalidValue" })) };
  }
  usesBudget(budget: ClinikoRequestBudget): boolean { return this.#config.cliniko.rateBudget === budget; }

  /** Runner-owned shared revocation store; caller and model inputs cannot select it. */
  withContactRevision(owner: import("../cliniko/contact-revision.ts").ClinikoContactRevisionReader): ClinikoVoiceClinicalHost {
    if (!owner.matches(this.#config.scope.tenantId, clinikoCredentialFingerprint(this.#config.cliniko.apiKey)) ||
        this.#config.correction && this.#config.correction.contactRevision !== owner ||
        this.#config.resend && this.#config.resend.contactRevision !== owner) throw new RangeError("contact account mismatch");
    return new ClinikoVoiceClinicalHost({ ...this.#config, cliniko: { ...this.#config.cliniko, contactRevision: owner } });
  }

  /** Rechecked on webhook admission AND stream construction. A changed route,
   * credential, policy, zone or cohort cannot silently reuse this host. */
  matches(approval: ClinikoSelectionApproval): boolean {
    const c = this.#config, p = approval.selection;
    return sameScope(c.scope, approval.scope) && c.policyVersion === p.policyVersion &&
      c.cliniko.businessId === p.businessId && c.cliniko.practitionerId === p.practitionerId &&
      c.cliniko.appointmentTypeId === p.appointmentTypeId && c.cliniko.timeZone === approval.businessTimeZone &&
      clinikoCredentialFingerprint(c.cliniko.apiKey) === approval.credentialFingerprint;
  }
  workflow(approval: ClinikoSelectionApproval): ClinikoVoiceWorkflow {
    if (!this.matches(approval)) throw new RangeError("clinical voice host binding mismatch");
    const c = this.#config;
    const { intake, correction, resend, financial, ...base } = c;
    const usedPolicies = this.#financialPolicies;
    return { policies: this.#policies, ...(c.publicKnowledge ? { publicKnowledge: c.publicKnowledge } : {}),
      ...(c.privateIntakeTranscription ? { privateIntakeTranscription: c.privateIntakeTranscription } : {}),
      ...(c.privateCorrectionTranscription ? { privateCorrectionTranscription: c.privateCorrectionTranscription } : {}),
      ...(c.privateRepresentativeTranscription ? { privateRepresentativeTranscription: c.privateRepresentativeTranscription } : {}),
      intent: c.intent,
      create(context) {
        if (!sameScope(context.receipt.scope, c.scope) || !context.sessionId ||
            context.receipt.callId !== callIdFor(context.inbound.key) ||
            context.receipt.admission.key.accountRef !== context.inbound.key.accountRef ||
            context.receipt.admission.key.providerCallRef !== context.inbound.key.providerCallRef ||
            context.receipt.admission.dialedNumber !== context.inbound.dialedNumber || resend && !context.resendPresentation ||
            financial && typeof context.financialPresentation?.play !== "function") {
          throw new RangeError("clinical voice admission mismatch");
        }
        let provision: FinancialBookingPreparationConfig | undefined;
        if (financial) {
          const { policyForCall, policy: sharedPolicy, ...common } = financial;
          const callContext = Object.freeze({ scope: Object.freeze({ ...c.scope }), callId: context.receipt.callId,
            sessionId: context.sessionId, signal: context.signal, clock: context.clock });
          if (!(callContext.signal instanceof AbortSignal) || callContext.signal.aborted || typeof callContext.clock !== "function") throw new RangeError("clinical voice admission mismatch");
          let policy: FinancialBookingPolicy | undefined;
          try { policy = policyForCall ? policyForCall(callContext) : sharedPolicy; }
          catch { throw new RangeError("clinical financial policy unavailable"); }
          if (!policyMethods(policy) || policyForCall && usedPolicies.has(policy!)) throw new RangeError("clinical financial policy unavailable");
          if (policyForCall) usedPolicies.add(policy!);
          provision = { ...common, native: { ...common.native, clock: context.clock }, policy: policySnapshot(policy!),
            presentation: Object.freeze({ play: context.financialPresentation!.play.bind(context.financialPresentation) }) };
        }
        const flow = ClinikoCallFlow.create({ ...base, ...context, policyVersion: c.policyVersion,
          ...(provision ? { financial: provision } : {}),
          ...(intake ? { intake: { ...intake, presentation: context.privatePresentation } } : {}),
          ...(correction ? { correction: { ...correction, presentation: context.privatePresentation } } : {}),
          ...(resend ? { resend: { ...resend, presentation: context.resendPresentation! } } : {}) });
        if (!flow.ok) throw new Error("clinical voice workflow unavailable");
        return flow.value;
      } };
  }
}
